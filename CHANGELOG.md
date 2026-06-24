## [Unreleased]

### Added

- Sliding window rate limiter middleware backed by Redis sorted sets
- Rate limit groups: auth (5 req/min), payment (60 req/min), readonly (300 req/min)
- `X-RateLimit-*` and `Retry-After` response headers
- Fails open when Redis is unavailable
