export const environments = {
  prod: 'https://api.menofhunger.com/v1',
  local: 'http://localhost:3001/v1',
};

export function configuredBaseUrl(profile) {
  if (profile !== undefined && !Object.hasOwn(environments, profile)) {
    throw new Error('Choose --env prod or --env local.');
  }
  return profile
    ? environments[profile]
    : process.env.MOH_API_BASE_URL || environments.prod;
}

export function serverName(baseUrl) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)
    ? 'menofhunger-local'
    : 'menofhunger';
}
