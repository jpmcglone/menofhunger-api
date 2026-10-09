import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { createHmac } from 'node:crypto';

const reservedV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  reservedV6.addSubnet(address, prefix, 'ipv6');

export function isPublicWebhookAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(a) && !reservedV6.check(a, 'ipv6');
  }
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function webhookSignature(body: string, timestamp: string, secret: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
export async function sendPartnerWebhook(url: string, body: string, secrets: string[], id: string): Promise<number> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || (target.port && target.port !== '443'))
    throw new Error('Invalid webhook destination.');
  const addresses = await lookup(target.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicWebhookAddress(a.address))) throw new Error('Webhook destination is not public.');
  const pinned = addresses[0];
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'POST',
        agent: false,
        timeout: 10_000,
        // DNS is resolved once, validated, and pinned. Redirects are never followed.
        lookup: ((_hostname: string, options: { all?: boolean }, callback: any) =>
          options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)) as any,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-MOH-Event-Id': id,
          'X-MOH-Signature': `t=${timestamp},${secrets.map((s) => `v1=${webhookSignature(body, timestamp, s)}`).join(',')}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 500);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Webhook timed out.')));
    req.on('error', reject);
    req.end(body);
  });
}
