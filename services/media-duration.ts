export function parseDurationTextToMs(value: unknown): number {
  const safe = String(value || '').trim().toLowerCase();
  if (!safe) return 0;

  const colonParts = safe.split(':').map((part) => Number(part.trim()));
  if (colonParts.length >= 2 && colonParts.length <= 3 && colonParts.every((part) => Number.isFinite(part))) {
    const normalized = colonParts.map((part) => Math.max(0, Math.floor(part)));
    const [hours, minutes, seconds] =
      normalized.length === 3 ? normalized : [0, normalized[0], normalized[1]];
    return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
  }

  const hourMatch = /([\d.,]+)\s*h(?:oras?)?/i.exec(safe);
  const minuteMatch = /([\d.,]+)\s*m(?:in(?:utos?)?)?/i.exec(safe);
  const secondMatch = /([\d.,]+)\s*s(?:eg(?:undos?)?)?/i.exec(safe);

  const parsePart = (raw: string | undefined) => {
    if (!raw) return 0;
    const normalized = Number(String(raw).replace(',', '.'));
    return Number.isFinite(normalized) ? normalized : 0;
  };

  const hours = parsePart(hourMatch?.[1]);
  const minutes = parsePart(minuteMatch?.[1]);
  const seconds = parsePart(secondMatch?.[1]);
  if (hours || minutes || seconds) {
    return Math.round(((hours * 3600) + (minutes * 60) + seconds) * 1000);
  }

  const bareMinutes = /^\d+(?:[.,]\d+)?$/.test(safe) ? Number(safe.replace(',', '.')) : NaN;
  if (Number.isFinite(bareMinutes) && bareMinutes > 0) {
    return Math.round(bareMinutes * 60 * 1000);
  }

  return 0;
}

export function coerceDurationMs(input: { text?: unknown; seconds?: unknown; milliseconds?: unknown }): number {
  const milliseconds = Number(input?.milliseconds || 0);
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return Math.round(milliseconds);
  }

  const seconds = Number(input?.seconds || 0);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }

  return parseDurationTextToMs(input?.text);
}