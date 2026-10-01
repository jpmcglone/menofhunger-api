declare module "twitter-text" {
  export function parseTweet(text: string): {
    weightedLength: number;
    valid: boolean;
  };
  export function extractUrlsWithIndices(
    text: string,
  ): Array<{ url: string; indices: [number, number] }>;
}
