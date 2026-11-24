import { Request, Response, NextFunction } from "express";
import axios from "axios";
import geoip from "geoip-lite";

interface GeoLocation {
  country: string;
  region?: string;
  city?: string;
  ll?: [number, number];
}

interface MaxMindCityResponse {
  country?: { iso_code?: string };
  subdivisions?: Array<{ iso_code?: string }>;
  city?: { names?: { en?: string } };
  location?: { latitude?: number; longitude?: number };
}

// Operational regions: African countries where mobile money services are supported
const OPERATIONAL_REGIONS = new Set([
  "CM", // Cameroon
  "UG", // Uganda
  "RW", // Rwanda
  "GH", // Ghana
  "KE", // Kenya
  "ZA", // South Africa
  "NG", // Nigeria
  "TZ", // Tanzania
  "SN", // Senegal
  "CI", // Côte d'Ivoire
  "BF", // Burkina Faso
  "ML", // Mali
  "BJ", // Benin
  "TG", // Togo
  "NE", // Niger
  "ZM", // Zambia
  "MW", // Malawi
  "MZ", // Mozambique
  "ZW", // Zimbabwe
  "BW", // Botswana
]);

// Sanctioned countries (OFAC, UN, EU sanctions lists)
const SANCTIONED_COUNTRIES = new Set([
  "CU", // Cuba
  "IR", // Iran
  "KP", // North Korea
  "SY", // Syria
  "RU", // Russia (partial sanctions)
  "BY", // Belarus
  "VE", // Venezuela (partial sanctions)
  "MM", // Myanmar (partial sanctions)
  "SD", // Sudan
  "SS", // South Sudan
]);

function extractClientIp(req: Request): string | null {
  return req.ip || null;
}

async function lookupGeoLocation(
  clientIp: string,
): Promise<GeoLocation | null> {
  let staticGeo: ReturnType<typeof geoip.lookup> = null;
  try {
    staticGeo = geoip.lookup(clientIp);
  } catch (error) {
    console.warn("[GEOFENCE] Static GeoIP lookup failed:", error);
  }

  if (staticGeo?.country) {
    return {
      country: staticGeo.country,
      region: staticGeo.region,
      city: staticGeo.city,
      ll: staticGeo.ll,
    };
  }

  const accountId = process.env.MAXMIND_ACCOUNT_ID;
  const licenseKey = process.env.MAXMIND_LICENSE_KEY;
  if (!accountId || !licenseKey) {
    return null;
  }

  const response = await axios.get<MaxMindCityResponse>(
    `https://geoip.maxmind.com/geoip/v2.1/city/${encodeURIComponent(clientIp)}`,
    {
      auth: { username: accountId, password: licenseKey },
      timeout: 5000,
    },
  );
  const country = response.data.country?.iso_code;
  if (!country) {
    return null;
  }

  const { latitude, longitude } = response.data.location ?? {};
  return {
    country,
    region: response.data.subdivisions?.[0]?.iso_code,
    city: response.data.city?.names?.en,
    ll:
      latitude !== undefined && longitude !== undefined
        ? [latitude, longitude]
        : undefined,
  };
}

/**
 * IP Geofencing Middleware
 * Validates that transactions originate from operational regions
 * and blocks requests from sanctioned jurisdictions
 */
export async function geoFencingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const clientIp = extractClientIp(req);

  if (!clientIp) {
    res.status(403).json({
      error: "Forbidden",
      message: "Unable to determine client IP address",
    });
    return;
  }

  // Skip validation for localhost/private IPs in development
  if (
    process.env.NODE_ENV !== "production" &&
    (clientIp === "127.0.0.1" ||
      clientIp === "::1" ||
      clientIp.startsWith("192.168.") ||
      clientIp.startsWith("10.") ||
      clientIp.startsWith("172."))
  ) {
    next();
    return;
  }

  let geo: GeoLocation | null;
  try {
    geo = await lookupGeoLocation(clientIp);
  } catch (error) {
    console.warn(
      `[GEOFENCE] GeoIP lookup failed for IP: ${clientIp}; allowing request`,
      error,
    );
    next();
    return;
  }

  if (!geo) {
    console.warn(
      `[GEOFENCE] Unable to determine location for IP: ${clientIp}; allowing request`,
    );
    next();
    return;
  }

  const countryCode = geo.country;

  // Check sanctioned countries first
  if (SANCTIONED_COUNTRIES.has(countryCode)) {
    console.warn(
      `[GEOFENCE] Blocked transaction from sanctioned country: ${countryCode}, IP: ${clientIp}`,
    );
    res.status(451).json({
      error: "Unavailable For Legal Reasons",
      message: `Transactions from ${countryCode} are not permitted due to sanctions`,
      countryCode,
    });
    return;
  }

  // Check operational regions
  if (!OPERATIONAL_REGIONS.has(countryCode)) {
    console.warn(
      `[GEOFENCE] Blocked transaction from unsupported region: ${countryCode}, IP: ${clientIp}`,
    );
    res.status(403).json({
      error: "Forbidden",
      message: `Service is not available in ${countryCode}. Supported regions: ${Array.from(OPERATIONAL_REGIONS).join(", ")}`,
      countryCode,
    });
    return;
  }

  // Attach geo info to request for downstream use
  (req as any).geoInfo = {
    country: countryCode,
    region: geo.region,
    city: geo.city,
    ll: geo.ll,
  };

  next();
}
