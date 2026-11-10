import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../lib/security/apiAuth';
import { inferenceMode } from '../../../agent/runtime/inference/policy';

export async function POST(req: NextRequest) {
  const denied = requireAuth(req, 'task');
  if (denied) return denied;
  try {
    const formData = await req.formData();
    const file = formData.get('file') as Blob | null;

    if (!file) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    // Hosted STT (Groq Whisper) is refused in offline-first mode; no local STT exists yet.
    if (inferenceMode() !== 'cloud') {
      return NextResponse.json(
        { error: 'Speech-to-text is unavailable offline: no local STT engine is installed, and cloud STT is disabled (DASK_INFERENCE=local).', unavailable: 'cloud-inference-disabled' },
        { status: 503 }
      );
    }

    const groqFormData = new FormData();
    groqFormData.append('file', file, 'audio.webm');
    groqFormData.append('model', 'whisper-large-v3');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: groqFormData as unknown as BodyInit,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Groq STT error:', errText);
      return NextResponse.json({ error: `Groq error: ${res.statusText}` }, { status: res.status });
    }

    const data = await res.json() as { text: string };
    return NextResponse.json({ text: data.text });
  } catch (error: any) {
    console.error('STT endpoint error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
