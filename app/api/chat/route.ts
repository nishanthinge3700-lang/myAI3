import { streamText, UIMessage, convertToModelMessages, stepCountIs, createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { MODEL } from '@/config';
import { SYSTEM_PROMPT } from '@/prompts';
import { isContentFlagged } from '@/lib/moderation';
import { webSearch } from './tools/web-search';
import { vectorDatabaseSearch } from './tools/search-vector-database';

import pdfParse from 'pdf-parse'; // npm i pdf-parse

export const maxDuration = 30;

function hasTextPart(p: unknown): p is { text: string } {
  return Boolean(p && typeof (p as any).text === 'string');
}

function extractTextFromParts(maybeParts: unknown): string {
  if (!Array.isArray(maybeParts)) return '';
  return maybeParts
    .filter((p) => (p as any).type === 'text' && hasTextPart(p))
    .map((p) => (p as any).text)
    .join('');
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const latestUserMessage = messages.filter((msg) => msg.role === 'user').pop();

  if (latestUserMessage) {
    const textParts = extractTextFromParts((latestUserMessage as any).parts);

    if (textParts) {
      const moderationResult = await isContentFlagged(textParts);

      if (moderationResult.flagged) {
        const stream = createUIMessageStream({
          execute({ writer }) {
            const textId = 'moderation-denial-text';

            writer.write({ type: 'start' });

            writer.write({ type: 'text-start', id: textId });
            writer.write({
              type: 'text-delta',
              id: textId,
              delta:
                moderationResult.denialMessage ||
                "Your message violates our guidelines. I can't answer that.",
            });
            writer.write({ type: 'text-end', id: textId });

            writer.write({ type: 'finish' });
          },
        });

        return createUIMessageStreamResponse({ stream });
      }
    }
  }

  // --- File detection (unchanged) ---
  let fileMessage: any | undefined = undefined;
  let fileMessageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m && m.metadata && m.metadata.fileContent) {
      fileMessage = m;
      fileMessageIndex = i;
      break;
    }
  }

  if (fileMessage) {
    const meta = fileMessage.metadata as {
      fileName?: string;
      fileType?: string;
      fileSize?: number;
      fileContent?: string;
    };
    const fileName = meta.fileName || 'uploaded-file';
    const mime = meta.fileType || 'unknown';
    const sizeKB = meta.fileSize ? Math.round(meta.fileSize / 1024) : 'unknown';

    const ackExistsAfter = messages.slice(fileMessageIndex + 1).some((m) => {
      if (m.role !== 'assistant' || !Array.isArray((m as any).parts)) return false;
      const parts = (m as any).parts;
      return parts.some((part: unknown) => hasTextPart(part) && part.text.includes(`Received "${fileName}"`));
    });

    if (ackExistsAfter) {
      // continue to checking for analyze command below
    } else {
      const userAfter = messages.slice(fileMessageIndex + 1).filter((m) => m.role === 'user');
      const latestUserAfter = userAfter.length ? userAfter[userAfter.length - 1] : null;
      const latestUserText = latestUserAfter ? extractTextFromParts((latestUserAfter as any).parts) : '';

      const wantsAnalyzeNow = /analyz|analyze|analysis|\bocr\b|\b(3)\b/i.test(latestUserText);

      // NOTE: The explicit verbose acknowledgement has been removed by design.
      // If the user explicitly asks to analyze (wantsAnalyzeNow) we'll proceed to analysis below.
      // Otherwise we fall through to the normal LLM flow so the assistant doesn't send the long redundant message.
    }

    // find latest user message after file message
    const userMessagesAfter = messages.slice(fileMessageIndex + 1).filter((m) => m.role === 'user');
    const latestUser = userMessagesAfter.length ? userMessagesAfter[userMessagesAfter.length - 1] : null;
    const latestUserText = latestUser ? extractTextFromParts((latestUser as any).parts) : '';

    const wantsAnalyze = /analyz|analyze|analysis|\bocr\b|\b(3)\b/i.test(latestUserText);

    if (wantsAnalyze && meta.fileContent) {
      // decode base64 to buffer:
      const base64WithPrefix = meta.fileContent as string;
      const base64 = base64WithPrefix.includes(',') ? base64WithPrefix.split(',')[1] : base64WithPrefix;
      const buffer = Buffer.from(base64, 'base64');

      // ---- PDF analysis branch ----
      if (mime.includes('pdf') || (fileName && fileName.toLowerCase().endsWith('.pdf'))) {
        async function analyzePdfBuffer(buf: Buffer, filename: string) {
          if (!process.env.OPENAI_API_KEY) {
            console.error('Missing OPENAI_API_KEY');
            return `Cannot analyze "${filename}" because OpenAI credentials are missing.`;
          }

          try {
            // extract text from PDF
            const pdfData = await pdfParse(buf);
            const fullText = (pdfData && pdfData.text) ? pdfData.text.trim() : '';

            if (!fullText || fullText.length === 0) {
              // likely a scanned PDF - instruct OCR or image upload
              return `I couldn't extract selectable text from "${filename}". It looks like a scanned document (images). If you want OCR, please upload the PDF pages as images or enable OCR processing.`;
            }

            // Truncate if extremely large; keep a large chunk of text for context
            const MAX_CHARS = 30000; // conservative to avoid token limits
            const snippet = fullText.length > MAX_CHARS ? fullText.slice(0, MAX_CHARS) + '\n\n[...document truncated...]' : fullText;

            // prepare a prompt asking for structured summary + TOC-like headings
            const promptText = `You are a helpful assistant. Given the extracted text of a PDF document, produce a concise structured response:
1) A 2-line human-readable summary.
2) A short "Table of Contents" style list of up to 12 headings/sections with approximate page numbers if available (use "unknown" if not).
3) A short list of 6 key bullet-point takeaways.
4) Return a JSON object with keys: summary, headings (array), takeaways (array), sample_snippet (first 400 characters of the document).
Do NOT hallucinate facts beyond the provided text. Include the filename in the response header.

DOCUMENT TEXT BEGIN:
${snippet}
DOCUMENT TEXT END.

Respond in plain text.`;

            // call OpenAI Responses API
            const payload = {
              model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini', // replace if you prefer another model
              input: [
                {
                  role: 'user',
                  content: [
                    { type: 'input_text', text: promptText },
                  ],
                },
              ],
              max_output_tokens: 800,
              temperature: 0.0,
            };

            const resp = await fetch('https://api.openai.com/v1/responses', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
            });

            if (!resp.ok) {
              const errText = await resp.text();
              console.error('OpenAI Responses API error (PDF):', resp.status, errText);
              return `OpenAI error while analyzing "${filename}": ${errText}`;
            }

            const j = await resp.json();

            let combinedText = '';

            // Try to read output from Responses API
            if (Array.isArray(j?.output) && j.output.length > 0) {
              // The Responses API may return structured content pieces
              combinedText = j.output
                .map((outItem: any) => {
                  // If there is content array with text fragments
                  if (Array.isArray(outItem.content)) {
                    return outItem.content.map((c: any) => c.text || c.description || '').filter(Boolean).join('');
                  }
                  // fallback to text or output_text
                  return outItem.text || '';
                })
                .filter(Boolean)
                .join('\n\n');
            }

            if (!combinedText) {
              combinedText = j.output_text || JSON.stringify(j, null, 2);
            }

            return `OpenAI analysis for "${filename}":\n\n${combinedText}`;
          } catch (err) {
            console.error('PDF analysis failed:', err);
            return `Failed to analyze "${filename}": ${String(err)}`;
          }
        }

        const analysisText = await analyzePdfBuffer(buffer, fileName);

        const stream = createUIMessageStream({
          execute({ writer }) {
            const textId = 'file-analysis-text';
            writer.write({ type: 'start' });

            writer.write({ type: 'text-start', id: textId });
            writer.write({
              type: 'text-delta',
              id: textId,
              delta: analysisText,
            });
            writer.write({ type: 'text-end', id: textId });
            writer.write({ type: 'finish' });
          },
        });

        return createUIMessageStreamResponse({ stream });
      }
      // ---- end PDF branch ----

      // ---- OpenAI Vision analysis function (existing image path) ----
      async function analyzeImageBuffer(buf: Buffer, filename: string, mimeType: string) {
        if (!process.env.OPENAI_API_KEY) {
          console.error('Missing OPENAI_API_KEY');
          return `Cannot analyze "${filename}" because OpenAI credentials are missing.`;
        }

        try {
          const base64 = buf.toString('base64');

          const promptText = `Extract all text (OCR) from the image. Then give a 2-line summary. Return JSON with keys: ocr_text, summary.`;

          // === IMPORTANT FIX: use `image: base64` (no image_base64, no mime_type, no filename) ===
          const payload = {
            model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini-vision',
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: promptText },
                  // <-- corrected image field:
                  { type: 'input_image', image: base64 }
                ]
              }
            ],
            max_output_tokens: 800,
            temperature: 0
          };

          const resp = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });

          if (!resp.ok) {
            const errText = await resp.text();
            console.error('OpenAI error:', resp.status, errText);
            return `OpenAI error while analyzing "${filename}": ${errText}`;
          }

          const j = await resp.json();

          let combinedText = '';

          // Try to read output from Responses API
          if (j?.output?.[0]?.content) {
            combinedText = j.output[0].content
              .map((c: any) => c.text || c.description || '')
              .filter(Boolean)
              .join('\n');
          }

          if (!combinedText) {
            combinedText = j.output_text || JSON.stringify(j);
          }

          return `OpenAI analysis for "${filename}":\n\n${combinedText}`;
        } catch (err) {
          console.error('Vision analysis failed:', err);
          return `Failed to analyze "${filename}": ${String(err)}`;
        }
      }
      // -----------------------------------------

      // if not PDF, image analysis handled above (or fallthrough)
    }

    // otherwise continue to LLM flow below
  }

  // --- Normal streaming LLM flow ---
  const result = streamText({
    model: MODEL,
    system: SYSTEM_PROMPT,
    messages: convertToModelMessages(messages),
    tools: {
      webSearch,
      vectorDatabaseSearch,
    },
    stopWhen: stepCountIs(10),
    providerOptions: {
      openai: {
        reasoningSummary: 'auto',
        reasoningEffort: 'low',
        parallelToolCalls: false,
      },
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
