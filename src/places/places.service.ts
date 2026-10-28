import { Injectable, Logger } from '@nestjs/common';

import { errorReason } from '../common/logger/error-reason';

export interface PlaceSuggestion {
  placeId: string;
  text: string;
}

export interface PlaceLocation {
  latitude: number;
  longitude: number;
  address: string;
}

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const REQUEST_TIMEOUT_MS = 8_000;

// مفتاح منفصل عن GOOGLE_MAPS_API_KEY بتاع تطبيق الجوال (app.json) — ده بيُستخدم
// هنا فقط عبر REST من السيرفر، فلازم يبقى بلا قيد "Android apps"، وإلا جوجل
// ترفض الطلب لأن قيد Android بيشتغل فقط مع مكتبات Android الأصلية.
@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);

  private apiKey(): string | null {
    return process.env.GOOGLE_PLACES_API_KEY?.trim() || null;
  }

  isConfigured(): boolean {
    return this.apiKey() != null;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async autocomplete(input: string): Promise<PlaceSuggestion[]> {
    const apiKey = this.apiKey();
    if (!apiKey) return [];

    try {
      const res = await this.fetchWithTimeout(AUTOCOMPLETE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify({
          input,
          languageCode: 'ar',
          regionCode: 'SA',
          // التطبيق يخدم عملاء داخل السعودية فقط حالياً.
          includedRegionCodes: ['sa'],
        }),
      });
      if (!res.ok) {
        // A restricted/invalid key (see the comment above) shows up only here.
        this.logger.warn({ msg: 'Places autocomplete rejected', status: res.status });
        return [];
      }
      const data = (await res.json()) as {
        suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[];
      };
      return (data.suggestions ?? [])
        .map((s) => s.placePrediction)
        .filter((p): p is { placeId: string; text?: { text?: string } } => Boolean(p?.placeId))
        .map((p) => ({ placeId: p.placeId, text: p.text?.text ?? '' }));
    } catch (e) {
      this.logger.warn({ msg: 'Places autocomplete failed', reason: errorReason(e) });
      return [];
    }
  }

  async details(placeId: string): Promise<PlaceLocation | null> {
    const apiKey = this.apiKey();
    if (!apiKey) return null;

    try {
      const res = await this.fetchWithTimeout(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
        {
          headers: {
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'location,formattedAddress,displayName',
          },
        },
      );
      if (!res.ok) {
        this.logger.warn({ msg: 'Places details rejected', status: res.status });
        return null;
      }
      const data = (await res.json()) as {
        location?: { latitude?: number; longitude?: number };
        formattedAddress?: string;
        displayName?: { text?: string };
      };
      if (data.location?.latitude == null || data.location?.longitude == null) return null;
      return {
        latitude: data.location.latitude,
        longitude: data.location.longitude,
        address: data.formattedAddress ?? data.displayName?.text ?? '',
      };
    } catch (e) {
      this.logger.warn({ msg: 'Places details failed', reason: errorReason(e) });
      return null;
    }
  }
}
