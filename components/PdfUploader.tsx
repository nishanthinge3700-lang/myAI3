// components/PdfUploader.tsx
'use client';
import React, { useState } from 'react';

export default function PdfUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<any>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
  };

  async function handleAnalyze() {
    if (!file) { alert('Choose a PDF first'); return; }
    if (file.size > 50 * 1024 * 1024 && !confirm('File >50MB may fail on serverless. Proceed?')) return;

    setStatus('Reading file...');
    const dataUrl = await fileToDataUrl(file);
    setStatus('Uploading and analyzing...');

    try {
      const res = await fetch('/api/pdf-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data_url: dataUrl, analysis: 'qa' })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Server failed');
      setResult(json);
      setStatus('Done');
    } catch (err: any) {
      setStatus('Error: ' + (err.message ?? err));
    }
  }

  return (
    <div className="p-3">
      <h4>Analyze PDF</h4>
      <input accept="application/pdf" type="file" onChange={handleFileChange} />
      <div className="mt-2">
        <button onClick={handleAnalyze} className="px-3 py-2 bg-blue-600 text-white rounded">Analyze PDF</button>
      </div>
      <div className="mt-2"><b>Status:</b> {status}</div>
      {result && (
        <div className="mt-4">
          <h5>Result</h5>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = (e) => reject(e);
    fr.readAsDataURL(file);
  });
}
