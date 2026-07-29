import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import * as StellarSdk from 'stellar-sdk';
import { StellarAccountViewer } from '../StellarAccountViewer';
import { useStellarAccount } from '../useStellarAccount';
import { renderHook, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock stellar-sdk
jest.mock('stellar-sdk', () => ({
  Keypair: {
    fromPublicKey: jest.fn((key: string) => {
      if (key.length === 56 && key.startsWith('G')) {
        return { publicKey: () => key };
      }
      throw new Error('Invalid key');
    }),
  },
  Horizon: {
    Server: jest.fn(function (this: any, url: string) {
      return {
        accounts: jest.fn(() => ({
          accountId: jest.fn(() => ({
            call: jest.fn(),
          })),
        })),
        operations: jest.fn(() => ({
          forAccount: jest.fn(() => ({
            order: jest.fn(function (this: any) { return this; }),
            limit: jest.fn(function (this: any) { return this; }),
            call: jest.fn(),
          })),
        })),
      };
    }),
  },
}));

describe('StellarAccountViewer', () => {
  const mockAccountId = 'GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE';

  const mockAccount = {
    id: mockAccountId,
    account_id: mockAccountId,
    balances: [
      {
        balance: '1000.50',
        asset_type: 'native' as const,
      },
    ],
    subentry_count: 2,
    last_modified_ledger: 12345,
    last_modified_time: new Date().toISOString(),
    thresholds: {
      low_threshold: 0,
      med_threshold: 0,
      high_threshold: 0,
    },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      clawback_enabled: false,
    },
    signers: [
      {
        key: mockAccountId,
        weight: 1,
        type: 'ed25519_public_key' as const,
      },
    ],
    data: {},
    sequence: '12345',
    sequence_ledger: 12345,
    sequence_time: new Date().toISOString(),
    num_sponsoring: 0,
    num_sponsored: 0,
  };

  const mockOperations = {
    _embedded: {
      records: [
        {
          id: '1',
          paging_token: '12345',
          transaction_hash: 'abc123',
          type: 'payment' as const,
          type_i: 1,
          created_at: new Date().toISOString(),
          transaction_successful: true,
          source_account: mockAccountId,
          amount: '100',
          asset_code: 'XLM',
        },
      ],
    },
    _links: {
      self: { href: 'https://example.com' },
      next: { href: 'https://example.com?next' },
      prev: { href: 'https://example.com?prev' },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock fetch for XLM price
    global.fetch = jest.fn(() =>
      Promise.resolve({
        json: () => Promise.resolve({ stellar: { usd: 0.35 } }),
      } as Response),
    );
  });

  describe('Loading State', () => {
    it('should show loading spinner initially', async () => {
      const { Horizon } = StellarSdk as any;
      const mockServer = new Horizon.Server('http://test');
      const mockAccountsCall = jest.fn(() =>
        new Promise(() => {}), // Never resolves
      );

      mockServer.accounts().accountId.mockReturnValue({
        call: mockAccountsCall,
      });

      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      const spinner = screen.getByTestId('balance-loading') || screen.getByText(/loading/i, { selector: 'p' });
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('Unfunded Account', () => {
    it('should display unfunded state when account not found', async () => {
      const { Horizon } = StellarSdk as any;
      const mockServer = new Horizon.Server('http://test');

      jest.spyOn(mockServer.accounts().accountId('test'), 'call').mockRejectedValue(
        new Error('404 - not found'),
      );

      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      await waitFor(() => {
        expect(screen.getByText(/Account Not Yet Created/i)).toBeInTheDocument();
      });

      expect(screen.getByText(/Send at least 1 XLM to activate/i)).toBeInTheDocument();
    });

    it('should show copy address button for unfunded account', async () => {
      const { Horizon } = StellarSdk as any;
      const mockServer = new Horizon.Server('http://test');

      jest.spyOn(mockServer.accounts().accountId('test'), 'call').mockRejectedValue(
        new Error('404 - not found'),
      );

      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      await waitFor(() => {
        const copyButton = screen.getByText(/Copy Address/i);
        expect(copyButton).toBeInTheDocument();
      });
    });
  });

  describe('Funded Account', () => {
    beforeEach(() => {
      const { Horizon } = StellarSdk as any;
      const mockServer = new Horizon.Server('http://test');

      jest
        .spyOn(mockServer.accounts().accountId('test'), 'call')
        .mockResolvedValue(mockAccount);

      jest
        .spyOn(mockServer.operations().forAccount('test').order('desc').limit(10), 'call')
        .mockResolvedValue(mockOperations);
    });

    it('should display account balance', async () => {
      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      await waitFor(() => {
        expect(screen.getByText(/1000.50/)).toBeInTheDocument();
        expect(screen.getByText('XLM')).toBeInTheDocument();
      });
    });

    it('should display account flags', async () => {
      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      await waitFor(() => {
        expect(screen.getByText(/Account Flags/)).toBeInTheDocument();
      });
    });

    it('should display operations history', async () => {
      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      await waitFor(() => {
        expect(screen.getByText(/Recent Operations/)).toBeInTheDocument();
      });
    });

    it('should show stellar.expert link', async () => {
      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      await waitFor(() => {
        const link = screen.getByText('🔗 Explore');
        expect(link).toBeInTheDocument();
        expect(link).toHaveAttribute('href', expect.stringContaining('stellar.expert'));
      });
    });
  });

  describe('Refresh Functionality', () => {
    it('should have refresh button', async () => {
      const { Horizon } = StellarSdk as any;
      const mockServer = new Horizon.Server('http://test');

      jest
        .spyOn(mockServer.accounts().accountId('test'), 'call')
        .mockResolvedValue(mockAccount);

      jest
        .spyOn(mockServer.operations().forAccount('test').order('desc').limit(10), 'call')
        .mockResolvedValue(mockOperations);

      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      await waitFor(() => {
        const refreshButton = screen.getByText(/Refresh/);
        expect(refreshButton).toBeInTheDocument();
      });
    });

    it('should call refetch when refresh button clicked', async () => {
      const { Horizon } = StellarSdk as any;
      const mockServer = new Horizon.Server('http://test');
      const callSpy = jest.spyOn(mockServer.accounts().accountId('test'), 'call')
        .mockResolvedValue(mockAccount);

      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      await waitFor(() => {
        const refreshButton = screen.getByText(/Refresh/);
        fireEvent.click(refreshButton);
      });

      await waitFor(() => {
        expect(callSpy).toHaveBeenCalledTimes(2); // Initial + refresh
      });
    });
  });

  describe('Error Handling', () => {
    it('should display error state on network failure', async () => {
      const { Horizon } = StellarSdk as any;
      const mockServer = new Horizon.Server('http://test');

      jest.spyOn(mockServer.accounts().accountId('test'), 'call').mockRejectedValue(
        new Error('Network error'),
      );

      render(
        <StellarAccountViewer
          accountId={mockAccountId}
          autoRefresh={false}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(/Failed to Load Account/i)).toBeInTheDocument();
      });
    });

    it('should call onError callback on error', async () => {
      const { Horizon } = StellarSdk as any;
      const mockServer = new Horizon.Server('http://test');
      const onError = jest.fn();

      jest.spyOn(mockServer.accounts().accountId('test'), 'call').mockRejectedValue(
        new Error('Test error'),
      );

      render(
        <StellarAccountViewer
          accountId={mockAccountId}
          autoRefresh={false}
          onError={onError}
        />,
      );

      await waitFor(() => {
        expect(onError).toHaveBeenCalled();
      });
    });
  });

  describe('Copy to Clipboard', () => {
    it('should copy account ID to clipboard', async () => {
      const { Horizon } = StellarSdk as any;
      const mockServer = new Horizon.Server('http://test');

      jest
        .spyOn(mockServer.accounts().accountId('test'), 'call')
        .mockResolvedValue(mockAccount);

      // Mock clipboard API
      Object.assign(navigator, {
        clipboard: {
          writeText: jest.fn(() => Promise.resolve()),
        },
      });

      render(
        <StellarAccountViewer accountId={mockAccountId} autoRefresh={false} />,
      );

      await waitFor(() => {
        const copyButton = screen.getByText(/Copy/);
        fireEvent.click(copyButton);
      });

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockAccountId);
      });
    });
  });
});

describe('useStellarAccount Hook', () => {
  const mockAccountId = 'GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE';

  const mockAccount = {
    id: mockAccountId,
    account_id: mockAccountId,
    balances: [
      {
        balance: '1000.50',
        asset_type: 'native' as const,
      },
    ],
    subentry_count: 2,
    last_modified_ledger: 12345,
    last_modified_time: new Date().toISOString(),
    thresholds: {
      low_threshold: 0,
      med_threshold: 0,
      high_threshold: 0,
    },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      clawback_enabled: false,
    },
    signers: [
      {
        key: mockAccountId,
        weight: 1,
        type: 'ed25519_public_key' as const,
      },
    ],
    data: {},
    sequence: '12345',
    sequence_ledger: 12345,
    sequence_time: new Date().toISOString(),
    num_sponsoring: 0,
    num_sponsored: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should initialize with loading state', () => {
    const { Horizon } = StellarSdk as any;
    const mockServer = new Horizon.Server('http://test');

    jest.spyOn(mockServer.accounts().accountId('test'), 'call').mockImplementation(
      () => new Promise(() => {}), // Never resolves
    );

    const { result } = renderHook(() =>
      useStellarAccount({
        accountId: mockAccountId,
        autoRefreshInterval: 0,
      }),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.account).toBeNull();
  });

  it('should fetch and set account data', async () => {
    const { Horizon } = StellarSdk as any;
    const mockServer = new Horizon.Server('http://test');

    jest
      .spyOn(mockServer.accounts().accountId('test'), 'call')
      .mockResolvedValue(mockAccount);

    jest.spyOn(mockServer.operations().forAccount('test').order('desc').limit(10), 'call')
      .mockResolvedValue({
        _embedded: { records: [] },
        _links: {
          self: { href: 'http://test' },
          next: { href: 'http://test' },
          prev: { href: 'http://test' },
        },
      });

    const { result } = renderHook(() =>
      useStellarAccount({
        accountId: mockAccountId,
        autoRefreshInterval: 0,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.account).toEqual(mockAccount);
      expect(result.current.xlmBalance).toBe('1000.50');
    });
  });

  it('should handle unfunded account', async () => {
    const { Horizon } = StellarSdk as any;
    const mockServer = new Horizon.Server('http://test');

    jest.spyOn(mockServer.accounts().accountId('test'), 'call')
      .mockRejectedValue(new Error('404 - not found'));

    const { result } = renderHook(() =>
      useStellarAccount({
        accountId: mockAccountId,
        autoRefreshInterval: 0,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isUnfunded).toBe(true);
      expect(result.current.account).toBeNull();
    });
  });

  it('should provide refetch function', async () => {
    const { Horizon } = StellarSdk as any;
    const mockServer = new Horizon.Server('http://test');
    const callSpy = jest.spyOn(mockServer.accounts().accountId('test'), 'call')
      .mockResolvedValue(mockAccount);

    jest.spyOn(mockServer.operations().forAccount('test').order('desc').limit(10), 'call')
      .mockResolvedValue({
        _embedded: { records: [] },
        _links: {
          self: { href: 'http://test' },
          next: { href: 'http://test' },
          prev: { href: 'http://test' },
        },
      });

    const { result } = renderHook(() =>
      useStellarAccount({
        accountId: mockAccountId,
        autoRefreshInterval: 0,
      }),
    );

    await waitFor(() => {
      expect(result.current.account).not.toBeNull();
    });

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(callSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('should validate account ID', () => {
    const { result } = renderHook(() =>
      useStellarAccount({
        accountId: 'INVALID',
        autoRefreshInterval: 0,
      }),
    );

    expect(result.current.error).toBeDefined();
    expect(result.current.error?.message).toContain('Invalid');
  });

  it('should have reset function', async () => {
    const { Horizon } = StellarSdk as any;
    const mockServer = new Horizon.Server('http://test');

    jest
      .spyOn(mockServer.accounts().accountId('test'), 'call')
      .mockResolvedValue(mockAccount);

    jest.spyOn(mockServer.operations().forAccount('test').order('desc').limit(10), 'call')
      .mockResolvedValue({
        _embedded: { records: [] },
        _links: {
          self: { href: 'http://test' },
          next: { href: 'http://test' },
          prev: { href: 'http://test' },
        },
      });

    const { result } = renderHook(() =>
      useStellarAccount({
        accountId: mockAccountId,
        autoRefreshInterval: 0,
      }),
    );

    await waitFor(() => {
      expect(result.current.account).not.toBeNull();
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.account).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });
});
