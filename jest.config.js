/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // esModuleInterop matches the swc production build's default-import handling
    // (without it, CJS default imports like `import sharp from 'sharp'` resolve
    // to undefined at test runtime).
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: { esModuleInterop: true } }],
  },
  testEnvironment: 'node',
  verbose: false,
};

