// route.ts (updated snippets — replace relevant parts in your file)
import { streamText, UIMessage, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { MODEL } from '@/config';
import { SYSTEM_PROMPT } from '@/prompts';
import { isContentFlagged } from '@/lib/moderation';
import { webSearch } from './tools/web-search';
import { vectorDatabaseSearch } from './tools/search-vector-database';
import pdfParse from 'pdf-parse';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import { createCanvas } from 'canvas';
import sharp from 'sharp';

export const maxDuration = 120; // increase if needed

// ... keep your hasTextPart and extractTextFromParts helpers ...

// ---------- Utility: chunk text into sizes ----------
function chunkText(text: string, maxChars = 3000) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + maxChars, text.length);
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

// ---------- Image analysis using Vercel AI SDK (streaming) ----------
async function analyzeImageBufferWithAiSdkStream(buf: Buffer, filename: string) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY');
  }
  const base64 = buf.toString('base64');
  const visionModel = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini-vision';

  // Step 1: ask model to OCR + structured extraction (JSON)
  const promptText =
    `You will be given an image. 1) Extract all visible text (OCR) under key "ocr_text". ` +
    `2) Detect and extract any tables (under "tables" as array of objects). 3) Provide a concise two-line summary under "summary". ` +
    `4) Provide a "confidence" field (low/medium/high) if possible. Return valid JSON only.`;

  const sdkStream = await streamText({
    model: visionModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: promptText },
          { type: 'input_image', image: base64 },
        ],
      },
    ],
    providerOptions: {
      openai: {
        reasoningEffort: 'medium',
      },
    },
  });

  // collect and return full text (the caller will stream to UI)
  let collected = '';
  for await (const chunk of sdkStream) {
    if (typeof chunk === 'string') collected += chunk;
    else if (chunk && typeof chunk === 'object') {
      if (typeof (chunk as any).text === 'string') collected += (chunk as any).text;
      else collected += JSON.stringify(chunk);
    }
  }
  return collected;
}

// ---------- PDF extraction (fast path) ----------
async function extractTextFromPdfBuffer(buf: Buffer) {
  try {
    const parsed = await pdfParse(buf);
    // pdf-parse gives `text` concatenated; pages may be separated by \n
    return parsed.text?.trim() ?? '';
  } catch (err) {
    console.warn('pdf-parse error', err);
    return '';
  }
}

// ---------- Render PDF pages to PNG buffers using pdfjs & canvas ----------
async function renderPdfPagesToPNGBuffers(buffer: Buffer, scale = 1.5) {
  // pdfjs expects an ArrayBuffer
  const arr = new Uint8Array(buffer).buffer;
  const loadingTask = pdfjsLib.getDocument({ data: arr });
  const pdf = await loadingTask.promise;
  const pages: Buffer[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });

    // create canvas with node-canvas
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = (canvas as any).getContext('2d');

    const renderContext = {
      canvasContext: ctx,
      viewport,
    };

    await page.render(renderContext).promise;

    // convert to buffer (PNG)
    const pngBuffer = canvas.toBuffer('image/png');
    pages.push(pngBuffer);
  }

  return pages;
}

// ---------- OCR a PDF buffer via vision model (per-page) ----------
async function ocrPdfViaVision(buf: Buffer) {
  // render pages to images
  const pageImages = await renderPdfPagesToPNGBuffers(buf, 1.5);

  // For each page, call vision model (can be batched if small)
  const perPageResults: string[] = [];
  for (let i = 0; i < pageImages.length; i++) {
    // Optionally downscale to limit payload
    const small = await sharp(pageImages[i]).resize({ width: 1600, withoutEnlargement: true }).png().toBuffer();
    const pageResult = await analyzeImageBufferWithAiSdkStream(small, `pdf-page-${i + 1}.png`);
    perPageResults.push(`--- PAGE ${i + 1} ---\n${pageResult}`);
  }
  return perPageResults.join('\n\n');
}

// ---------- Summarize long text by chunking and asking model to combine ----------
async function summarizeLongTextWithSdk(text: string, filename = 'document') {
  const model = MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
  const chunks = chunkText(text, 2800);

  // For each chunk ask for concise JSON summary
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const msg = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: `Summarize the following passage and extract key items (title, headings, important bullet points). Return JSON with keys: "title", "bullets" (array), "excerpt". Passage ${i + 1}/${chunks.length}:\n\n${chunks[i]}` },
        ],
      },
    ];

    const sdkStream = await streamText({
      model,
      messages: msg,
      providerOptions: {
        openai: { reasoningEffort: 'medium' },
      },
    });

    let collected = '';
    for await (const chunk of sdkStream) {
      if (typeof chunk === 'string') collected += chunk;
      else if (chunk && (chunk as any).text) collected += (chunk as any).text;
    }
    chunkSummaries.push(collected.trim());
  }

  // Combine chunk summaries into a final summary
  const combinePrompt = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: `You are given ${chunkSummaries.length} chunk summaries (possibly as JSON or text). Combine them into a single structured JSON with keys: overall_summary (3-5 bullet points), important_entities (list), recommendations (if any). Ensure validity JSON only.` },
        { type: 'input_text', text: chunkSummaries.join('\n\n') },
      ],
    },
  ];

  const sdkStream = await streamText({
    model,
    messages: combinePrompt,
    providerOptions: { openai: { reasoningEffort: 'high' } },
  });

  let collected = '';
  for await (const c of sdkStream) {
    if (typeof c === 'string') collected += c;
    else if (c && (c as any).text) collected += (c as any).text;
  }

  return collected.trim();
}

// ---------- Main POST handling (file portion integrated) ----------
export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // --- moderation + file detection unchanged up top (keep yours) ---
  // ... your moderation code here (unchanged) ...

  // locate latest file message (your existing logic) - simplified copy:
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
    const meta = fileMessage.metadata as { fileName?: string; fileType?: string; fileSize?: number; fileContent?: string };
    const fileName = meta.fileName || 'uploaded-file';
    const mime = meta.fileType || 'unknown';
    const base64WithPrefix = meta.fileContent as string;
    const base64 = base64WithPrefix.includes(',') ? base64WithPrefix.split(',')[1] : base64WithPrefix;
    const buffer = Buffer.from(base64, 'base64');

    // find user's analyze command after upload
    const userMessagesAfter = messages.slice(fileMessageIndex + 1).filter((m) => m.role === 'user');
    const latestUser = userMessagesAfter.length ? userMessagesAfter[userMessagesAfter.length - 1] : null;
    const latestUserText = latestUser ? extractTextFromParts((latestUser as any).parts) : '';
    const wantsAnalyze = /analyz|analyze|analysis|\bocr\b|\b(3)\b/i.test(latestUserText);

    if (!wantsAnalyze) {
      // send your "what do you want me to do?" message (unchanged)
      const stream = createUIMessageStream({
        execute({ writer }) {
          const textId = 'file-received-text';
          writer.write({ type: 'start' });
          writer.write({ type: 'text-start', id: textId });
          writer.write({
            type: 'text-delta',
            id: textId,
            delta: `Received "${fileName}" (${mime}). I can (1) summarize text, (2) run OCR, (3) analyze images, or (4) extract tables. What would you like me to do with this file?`,
          });
          writer.write({ type: 'text-end', id: textId });
          writer.write({ type: 'finish' });
        },
      });
      return createUIMessageStreamResponse({ stream });
    }

    // ---------- Now handle analysis ----------
    // We'll create a UI streaming response and pipe the model output progressively
    const uiStream = createUIMessageStream({
      async execute({ writer }) {
        const textId = 'file-analysis-text';
        writer.write({ type: 'start' });
        writer.write({ type: 'text-start', id: textId });

        try {
          if (mime === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
            // 1) try fast text extraction
            const extractedText = await extractTextFromPdfBuffer(buffer);
            if (extractedText && extractedText.length > 200) {
              // chunk + summarize
              const combined = await summarizeLongTextWithSdk(extractedText, fileName);
              writer.write({ type: 'text-delta', id: textId, delta: `Extracted text from PDF. Summary and structured output:\n\n${combined}` });
            } else {
              // fallback: render pages + OCR via vision model
              writer.write({ type: 'text-delta', id: textId, delta: `PDF appears to be scanned. Running per-page OCR (this may take a while)...\n` });
              const ocrAll = await ocrPdfViaVision(buffer);
              // Summarize the OCR result
              const summary = await summarizeLongTextWithSdk(ocrAll, fileName);
              writer.write({ type: 'text-delta', id: textId, delta: `OCR complete. Combined summary:\n\n${summary}` });
            }
          } else if (mime.startsWith('image/') || ['image/png','image/jpeg','image/jpg'].includes(mime)) {
            // Direct image analysis
            writer.write({ type: 'text-delta', id: textId, delta: `Analyzing image "${fileName}"...\n` });
            const imageResult = await analyzeImageBufferWithAiSdkStream(buffer, fileName);
            writer.write({ type: 'text-delta', id: textId, delta: `Analysis result:\n\n${imageResult}` });
          } else {
            // Unknown file type: try to extract text (if it's a text-based file)
            writer.write({ type: 'text-delta', id: textId, delta: `Unknown file type (${mime}). Attempting to extract text...\n` });
            const maybeText = buffer.toString('utf8');
            if (maybeText && maybeText.length > 100) {
              const summary = await summarizeLongTextWithSdk(maybeText, fileName);
              writer.write({ type: 'text-delta', id: textId, delta: `Extracted text summary:\n\n${summary}` });
            } else {
              writer.write({ type: 'text-delta', id: textId, delta: `Couldn't extract meaningful text from this file.` });
            }
          }
        } catch (err) {
          console.error('File analysis pipeline failed:', err);
          writer.write({ type: 'text-delta', id: textId, delta: `Error during analysis: ${String(err)}` });
        }

        writer.write({ type: 'text-end', id: textId });
        writer.write({ type: 'finish' });
      },
    });

    return createUIMessageStreamResponse({ stream: uiStream });
  }

  // --------- Normal LLM flow (no file) ----------
  // Use streamText but remove the stepCountIs truncation & increase reasoning effort
  const result = streamText({
    model: MODEL,
    system: SYSTEM_PROMPT,
    messages: convertToModelMessages(messages),
    tools: { webSearch, vectorDatabaseSearch },
    providerOptions: {
      openai: {
        reasoningSummary: 'auto',
        reasoningEffort: 'medium', // increase depth
        parallelToolCalls: false,
      },
    },
    // no stopWhen (let model finish), or change to something more permissive if needed
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
