import express from "express";
import request from "supertest";
import axios from "axios";
import geoip from "geoip-lite";
import { geoFencingMiddleware } from "../geoFencing";

jest.mock("axios", () => ({ get: jest.fn() }));
jest.mock("geoip-lite", () => ({ lookup: jest.fn() }));

const mockedAxiosGet = jest.mocked(axios.get);
const mockedGeoipLookup = jest.mocked(geoip.lookup);

describe("geoFencingMiddleware", () => {
  const previousEnvironment = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "production";
    delete process.env.MAXMIND_ACCOUNT_ID;
    delete process.env.MAXMIND_LICENSE_KEY;
    mockedGeoipLookup.mockReturnValue(null);
  });

  afterAll(() => {
    process.env = previousEnvironment;
  });

  function buildApp() {
    const app = express();
    app.use(geoFencingMiddleware);
    app.get("/", (_req, res) => res.status(200).json({ allowed: true }));
    return app;
  }

  it("fails open with a warning when both GeoIP lookups are unavailable", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation();

    const response = await request(buildApp())
      .get("/")
      .set("x-forwarded-for", "198.51.100.42");

    expect(response.status).toBe(200);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Unable to determine location"),
    );
    expect(mockedAxiosGet).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("uses MaxMind when the static database has no result", async () => {
    process.env.MAXMIND_ACCOUNT_ID = "account";
    process.env.MAXMIND_LICENSE_KEY = "license";
    mockedAxiosGet.mockResolvedValue({
      data: { country: { iso_code: "IR" } },
    } as never);
    const warning = jest.spyOn(console, "warn").mockImplementation();

    const response = await request(buildApp())
      .get("/")
      .set("x-forwarded-for", "198.51.100.42");

    expect(response.status).toBe(451);
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining("/city/198.51.100.42"),
      expect.objectContaining({
        auth: { username: "account", password: "license" },
      }),
    );
    warning.mockRestore();
  });

  it("fails open with a warning when MaxMind lookup fails", async () => {
    process.env.MAXMIND_ACCOUNT_ID = "account";
    process.env.MAXMIND_LICENSE_KEY = "license";
    mockedAxiosGet.mockRejectedValue(new Error("provider unavailable"));
    const warning = jest.spyOn(console, "warn").mockImplementation();

    const response = await request(buildApp())
      .get("/")
      .set("x-forwarded-for", "198.51.100.42");

    expect(response.status).toBe(200);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("GeoIP lookup failed"),
      expect.any(Error),
    );
    warning.mockRestore();
  });
});
