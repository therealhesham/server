import { Injectable } from '@nestjs/common';

// Mirrors rentcar's lib/evolution-whatsapp.ts postSendText/isEvolutionWhatsAppConfigured
// exactly — same Evolution API contract, same env var names, so the same
// WhatsApp instance/credentials rentcar uses in production work here unchanged.
@Injectable()
export class EvolutionWhatsAppService {
  isConfigured(): boolean {
    const base = process.env.EVOLUTION_API_BASE_URL?.trim();
    const key = process.env.EVOLUTION_API_KEY?.trim();
    const inst = process.env.EVOLUTION_INSTANCE_NAME?.trim();
    return Boolean(base && key && inst);
  }

  async sendText(number: string, text: string): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('Evolution API غير مهيأ (EVOLUTION_API_BASE_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE_NAME).');
    }
    const base = process.env.EVOLUTION_API_BASE_URL!.trim().replace(/\/+$/, '');
    const key = process.env.EVOLUTION_API_KEY!.trim();
    const instance = process.env.EVOLUTION_INSTANCE_NAME!.trim();
    const url = `${base}/message/sendText/${encodeURIComponent(instance)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key },
        body: JSON.stringify({ number, text, options: { linkPreview: false } }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 500)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
