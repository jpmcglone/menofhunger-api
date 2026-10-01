/** Code checks only; real codec validation remains in the local release gate. */
module.exports = {
  ...require('./jest.config'),
  testPathIgnorePatterns: [
    '/node_modules/',
    '/src/modules/uploads/avatar-video-transcoder\\.spec\\.ts$',
  ],
};
