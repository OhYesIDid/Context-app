import Purchases from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';
import { NativeModules } from 'react-native';
import {
  PRO_ENTITLEMENT,
  configurePurchases,
  checkProEntitlement,
  addEntitlementListener,
  fetchOfferings,
  purchasePkg,
  restorePurchases,
  presentCustomerCenter,
} from '../purchases';

jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    setLogLevel: jest.fn(),
    configure: jest.fn(),
    getAppUserID: jest.fn(),
    getCustomerInfo: jest.fn(),
    addCustomerInfoUpdateListener: jest.fn(),
    removeCustomerInfoUpdateListener: jest.fn(),
    getOfferings: jest.fn(),
    purchasePackage: jest.fn(),
    restorePurchases: jest.fn(),
  },
  LOG_LEVEL: { DEBUG: 'DEBUG' },
}));

jest.mock('react-native-purchases-ui', () => ({
  __esModule: true,
  default: { presentCustomerCenter: jest.fn() },
}));

function customerInfoWithPro(isPro: boolean) {
  return { entitlements: { active: isPro ? { [PRO_ENTITLEMENT]: {} } : {} } } as any;
}

describe('purchases service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    NativeModules.ProTxtSettings = {
      setProStatus: jest.fn(),
      setAppUserId: jest.fn(),
    };
  });

  describe('configurePurchases', () => {
    it('configures RevenueCat with the API key and syncs the app user id', async () => {
      (Purchases.getAppUserID as jest.Mock).mockResolvedValue('rc-user-1');

      configurePurchases();
      // syncAppUserIdToNative is fire-and-forget inside configurePurchases
      await Promise.resolve();
      await Promise.resolve();

      expect(Purchases.configure).toHaveBeenCalledWith(expect.objectContaining({ apiKey: expect.any(String) }));
      expect(NativeModules.ProTxtSettings.setAppUserId).toHaveBeenCalledWith('rc-user-1');
    });

    it('does not throw if Purchases.configure itself throws', () => {
      (Purchases.configure as jest.Mock).mockImplementation(() => {
        throw new Error('native module unavailable');
      });

      expect(() => configurePurchases()).not.toThrow();
    });

    it('does not throw if syncing the app user id fails', async () => {
      (Purchases.getAppUserID as jest.Mock).mockRejectedValue(new Error('not configured'));

      expect(() => configurePurchases()).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      // swallowed — no assertion needed beyond "didn't throw"
    });
  });

  describe('checkProEntitlement', () => {
    it('returns true and syncs native state when the entitlement is active', async () => {
      (Purchases.getCustomerInfo as jest.Mock).mockResolvedValue(customerInfoWithPro(true));

      const result = await checkProEntitlement();

      expect(result).toBe(true);
      expect(NativeModules.ProTxtSettings.setProStatus).toHaveBeenCalledWith(true);
    });

    it('returns false and syncs native state when the entitlement is not active', async () => {
      (Purchases.getCustomerInfo as jest.Mock).mockResolvedValue(customerInfoWithPro(false));

      const result = await checkProEntitlement();

      expect(result).toBe(false);
      expect(NativeModules.ProTxtSettings.setProStatus).toHaveBeenCalledWith(false);
    });

    it('returns false without throwing when RevenueCat errors — indistinguishable from "not entitled"', async () => {
      (Purchases.getCustomerInfo as jest.Mock).mockRejectedValue(new Error('network error'));

      const result = await checkProEntitlement();

      expect(result).toBe(false);
      // documents current behavior: a network failure never reaches the native sync call
      expect(NativeModules.ProTxtSettings.setProStatus).not.toHaveBeenCalled();
    });
  });

  describe('addEntitlementListener', () => {
    it('invokes the callback with the current Pro state and syncs it to native', () => {
      const cb = jest.fn();
      addEntitlementListener(cb);

      const handler = (Purchases.addCustomerInfoUpdateListener as jest.Mock).mock.calls[0][0];
      handler(customerInfoWithPro(true));

      expect(cb).toHaveBeenCalledWith(true);
      expect(NativeModules.ProTxtSettings.setProStatus).toHaveBeenCalledWith(true);
    });

    it('returns an unsubscribe function that removes the listener', () => {
      const unsubscribe = addEntitlementListener(jest.fn());
      const handler = (Purchases.addCustomerInfoUpdateListener as jest.Mock).mock.calls[0][0];

      unsubscribe();

      expect(Purchases.removeCustomerInfoUpdateListener).toHaveBeenCalledWith(handler);
    });
  });

  describe('fetchOfferings', () => {
    it('resolves with the offerings on success', async () => {
      const offerings = { all: { default: {} }, current: { availablePackages: [] } };
      (Purchases.getOfferings as jest.Mock).mockResolvedValue(offerings);

      await expect(fetchOfferings()).resolves.toBe(offerings);
    });

    it('resolves null when RevenueCat rejects', async () => {
      (Purchases.getOfferings as jest.Mock).mockRejectedValue(new Error('offline'));

      await expect(fetchOfferings()).resolves.toBeNull();
    });

    it('resolves null if RevenueCat never responds within the timeout', async () => {
      jest.useFakeTimers();
      (Purchases.getOfferings as jest.Mock).mockReturnValue(new Promise(() => {}));

      const promise = fetchOfferings();
      jest.advanceTimersByTime(15_000);

      await expect(promise).resolves.toBeNull();
      jest.useRealTimers();
    });
  });

  describe('purchasePkg', () => {
    const pkg = { identifier: 'pro_monthly' } as any;

    it('returns true when the purchase grants the Pro entitlement', async () => {
      (Purchases.purchasePackage as jest.Mock).mockResolvedValue({ customerInfo: customerInfoWithPro(true) });

      await expect(purchasePkg(pkg)).resolves.toBe(true);
    });

    it('returns false when the purchase completes without the Pro entitlement', async () => {
      (Purchases.purchasePackage as jest.Mock).mockResolvedValue({ customerInfo: customerInfoWithPro(false) });

      await expect(purchasePkg(pkg)).resolves.toBe(false);
    });

    it('propagates rejection (e.g. user-cancelled) instead of swallowing it — callers must catch', async () => {
      const cancelled = Object.assign(new Error('cancelled'), { userCancelled: true });
      (Purchases.purchasePackage as jest.Mock).mockRejectedValue(cancelled);

      await expect(purchasePkg(pkg)).rejects.toBe(cancelled);
    });
  });

  describe('restorePurchases', () => {
    it('returns true when a restored entitlement is active', async () => {
      (Purchases.restorePurchases as jest.Mock).mockResolvedValue(customerInfoWithPro(true));

      await expect(restorePurchases()).resolves.toBe(true);
    });

    it('returns false when no active entitlement is restored', async () => {
      (Purchases.restorePurchases as jest.Mock).mockResolvedValue(customerInfoWithPro(false));

      await expect(restorePurchases()).resolves.toBe(false);
    });

    it('returns false without throwing when RevenueCat errors', async () => {
      (Purchases.restorePurchases as jest.Mock).mockRejectedValue(new Error('network error'));

      await expect(restorePurchases()).resolves.toBe(false);
    });
  });

  describe('presentCustomerCenter', () => {
    it('swallows errors from the native UI presentation', async () => {
      (RevenueCatUI.presentCustomerCenter as jest.Mock).mockRejectedValue(new Error('no activity'));

      await expect(presentCustomerCenter()).resolves.toBeUndefined();
    });
  });
});
