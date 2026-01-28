export function publicAssetUrl(params: {
  publicBaseUrl: string | null | undefined;
  key: string | null | undefined;
  updatedAt?: Date | string | null | undefined;
}): string | null {
  const base = (params.publicBaseUrl ?? '').trim().replace(/\/+$/, '');
  const key = (params.key ?? '').trim().replace(/^\/+/, '');
  if (!base || !key) return null;

  const vRaw = params.updatedAt ?? null;
  const v =
    typeof vRaw === 'string'
      ? vRaw.trim()
      : vRaw instanceof Date
        ? vRaw.toISOString()
        : '';

  const url = `${base}/${key}`;
  return v ? `${url}?v=${encodeURIComponent(v)}` : url;
}

