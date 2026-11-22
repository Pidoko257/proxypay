import { Request, Response, NextFunction } from "express";
import geoip from "geoip-lite";
import { geoFencingMiddleware } from "../geoFencing";
import { ipWhitelist } from "../ipWhitelist";
import { geolocationService } from "../../services/geolocation";

jest.mock("geoip-lite", () => ({
  __esModule: true,
  default: { lookup: jest.fn() },
}));

jest.mock("../../services/geolocation", () => ({
  geolocationService: { lookup: jest.fn() },
}));

jest.mock("../../config/redis", () => ({
  redisClient: { get: jest.fn(), setEx: jest.fn() },
}));

const CLIENT_IP = "198.51.100.10";

function makeRequest(): Request {
  return {
    ip: CLIENT_IP,
    headers: { "x-forwarded-for": "127.0.0.1" },
    socket: { remoteAddress: "10.0.0.1" },
    params: {},
    body: {},
  } as Request;
}

function makeResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return res as unknown as Response;
}

describe("client IP middleware", () => {
  const next = jest.fn() as NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses Express's resolved IP for geo-fencing", () => {
    jest.spyOn(geoip, "lookup").mockReturnValue({
      country: "KE",
      region: "",
      city: "",
      ll: [0, 0],
    });
    const res = makeResponse();

    geoFencingMiddleware(makeRequest(), res, next);

    expect(geoip.lookup).toHaveBeenCalledWith(CLIENT_IP);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("uses Express's resolved IP for provider whitelisting", async () => {
    jest.spyOn(geolocationService, "lookup").mockResolvedValue({
      country: "Kenya",
      countryCode: "KE",
      city: "",
      isp: "",
      lat: 0,
      lon: 0,
      status: "resolved",
    });

    await ipWhitelist(makeRequest(), makeResponse(), next);

    expect(geolocationService.lookup).toHaveBeenCalledWith(CLIENT_IP);
    expect(next).toHaveBeenCalled();
  });
});
