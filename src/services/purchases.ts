import Purchases, {
  LOG_LEVEL,
  type PurchasesOfferings,
  type PurchasesPackage,
} from 'react-native-purchases';

// Get this from the RevenueCat dashboard → Apps → Android → API key (starts with "goog_")
const RC_API_KEY_ANDROID = 'REVENUECAT_ANDROID_API_KEY_PLACEHOLDER';

export const PRO_ENTITLEMENT = 'pro';

export function configurePurchases() {
  if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  Purchases.configure({ apiKey: RC_API_KEY_ANDROID });
}

export async function checkProEntitlement(): Promise<boolean> {
  try {
    const info = await Purchases.getCustomerInfo();
    return !!info.entitlements.active[PRO_ENTITLEMENT];
  } catch {
    return false;
  }
}

export function addEntitlementListener(cb: (isPro: boolean) => void): () => void {
  const handler = (info: import('react-native-purchases').CustomerInfo) => {
    cb(!!info.entitlements.active[PRO_ENTITLEMENT]);
  };
  Purchases.addCustomerInfoUpdateListener(handler);
  return () => Purchases.removeCustomerInfoUpdateListener(handler);
}

export async function fetchOfferings(): Promise<PurchasesOfferings | null> {
  try {
    return await Purchases.getOfferings();
  } catch {
    return null;
  }
}

export async function purchasePkg(pkg: PurchasesPackage): Promise<boolean> {
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return !!customerInfo.entitlements.active[PRO_ENTITLEMENT];
}

export async function restorePurchases(): Promise<boolean> {
  try {
    const info = await Purchases.restorePurchases();
    return !!info.entitlements.active[PRO_ENTITLEMENT];
  } catch {
    return false;
  }
}
