import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as Blob | null;

    if (!file) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
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
