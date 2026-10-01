// Official twitter-text 3.1.0, Apache-2.0. Shared by API, browser and JavaScriptCore.
const parseTweet = require('twitter-text/dist/parseTweet');
const extractUrls = require('twitter-text/dist/extractUrlsWithIndices');
exports.weightedLength = text => parseTweet(text).weightedLength;
exports.containsLink = text => extractUrls(text).length > 0 || /https?:\/\/|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]+)(?![\p{L}\p{N}-])/iu.test(text);
