jest.mock('../../src/config/database', () => ({
  pool: { query: jest.fn() },
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));
jest.mock('../../src/config/redis', () => ({ redisClient: { get: jest.fn(), set: jest.fn() } }));
// blendScores is pure; stub the model layer so the test doesn't need a DB.
jest.mock('../../src/models/transaction', () => ({
  TransactionModel: jest.fn(),
  TransactionStatus: { Failed: 'failed', Success: 'completed' },
}));
jest.mock('../../src/models/users', () => ({ UserModel: jest.fn() }));
jest.mock('../../src/models/fraudAlert', () => ({ FraudAlertModel: jest.fn() }));
jest.mock('../../src/services/fraudLoggingService', () => ({ fraudLoggingService: {} }));

import { FraudService } from '../../src/services/fraud';

describe('FraudService.blendScores', () => {
  const blend = (svc: FraudService, heuristic: number, ml?: number): number =>
    (svc as unknown as { blendScores(h: number, m?: number): number }).blendScores(heuristic, ml);

  it('caps the blended score at 100', () => {
    const svc = new FraudService({ fraudScoreThreshold: 50 });
    // 75 + 1.0 * 50 * 0.3 = 90 (in range); 95 + 15 = 110 must be capped
    expect(blend(svc, 75, 1.0)).toBe(90);
    expect(blend(svc, 95, 1.0)).toBe(100);
    expect(blend(svc, 100, 1.0)).toBe(100);
  });

  it('caps even with a large configured threshold', () => {
    const svc = new FraudService({ fraudScoreThreshold: 1000 });
    expect(blend(svc, 10, 1.0)).toBe(100);
  });

  it('returns the heuristic score unchanged when there is no ML score', () => {
    const svc = new FraudService({ fraudScoreThreshold: 50 });
    expect(blend(svc, 40)).toBe(40);
  });
});
