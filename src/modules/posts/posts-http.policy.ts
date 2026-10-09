import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";

export const postReadThrottle = {
  default: {
    limit: rateLimitLimit("read", 120),
    ttl: rateLimitTtl("read", 60),
  },
};
