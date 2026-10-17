import { describe, expect, it } from "vitest";
import { CHOKEPOINTS } from "@/utils/api";
import { findPlaces, PLACES, placeReason, placeText } from "./places";

const primaryId = (title: string, summary?: string, institutions = true) => placeText(title, summary, { institutions }).primary?.place.id ?? null;

describe("findPlaces: word boundaries", () => {
  it("does not match inside longer words", () => {
    expect(primaryId("Indiana governor signs budget")).toBeNull();
    expect(primaryId("Tirana protests continue")).toBeNull();
    expect(primaryId("Indochina trade route study")).toBeNull();
  });
  it("matches adjectives as the country", () => {
    expect(primaryId("Indian rupee hits a record low")).toBe("IN");
    expect(primaryId("Iranian navy seizes a tanker")).toBe("IR");
  });
});

describe("findPlaces: no commodity proxies", () => {
  it("never places gold in South Africa", () => {
    expect(primaryId("Gold hits record as Fed cut bets rise")).toBe("US");
    expect(placeText("Gold hits record as Fed cut bets rise").primary?.via).toBe("institution");
    expect(primaryId("Gold hits record as Fed cut bets rise", undefined, false)).toBeNull();
    expect(primaryId("Copper and silver extend gains; lithium flat")).toBeNull();
  });
});

describe("findPlaces: specific beats general", () => {
  it("Taiwan Strait is the chokepoint at CHOKEPOINTS coordinates; Taiwan alone is the country", () => {
    const strait = placeText("Warships transit the Taiwan Strait").primary!;
    const spec = CHOKEPOINTS.find((c) => c.id === "TAIWAN")!;
    expect(strait.place.id).toBe("TAIWAN");
    expect([strait.place.lat, strait.place.lng]).toEqual([spec.lat, spec.lng]);
    expect(primaryId("Taiwan election result lifts chip stocks")).toBe("TW");
  });
  it("Panama Canal is the chokepoint; Panama alone is the country", () => {
    expect(primaryId("Panama Canal cuts daily transits")).toBe("PANAMA");
    expect(primaryId("Panama election goes to a runoff")).toBe("PA");
  });
});

describe("findPlaces: names inside other proper nouns", () => {
  it("Panama Papers and the Washington Post are not places", () => {
    expect(primaryId("Panama Papers: new names published")).toBeNull();
    expect(primaryId("Washington Post layoffs hit the newsroom")).toBeNull();
    expect(primaryId("Officials in Washington weigh new tariffs")).toBe("WASHINGTON");
    // A later, plain mention still places the story.
    expect(primaryId("Panama Papers fallout reaches Panama's president")).toBe("PA");
  });
  it("Red Sea and Bab el-Mandeb use the CHOKEPOINTS coordinates", () => {
    const m = placeText("Red Sea attacks near Bab el-Mandeb").primary!;
    expect(m.place.id).toBe("RED_SEA");
    expect([m.place.lat, m.place.lng]).toEqual([12.6, 43.3]);
    expect(placeText("Red Sea attacks near Bab el-Mandeb").also).toEqual([]);
  });
});

describe("placeText: order", () => {
  it("the earliest place in the text is the primary one", () => {
    const r = placeText("Iran warns Israel over strikes");
    expect(r.primary?.place.id).toBe("IR");
    expect(r.also.map((m) => m.place.id)).toEqual(["IL"]);
  });
  it("the title decides before the summary", () => {
    const r = placeText(
      "Drone strikes hit Russia's Primorsk oil port; loadings suspended",
      "Baltic export terminal halts loadings after overnight strikes; about 1 mb/d of seaborne crude affected for at least two days.",
    );
    expect(r.primary?.place.id).toBe("RU");
    expect(r.primary?.field).toBe("title");
  });
  it("uses the summary only when the title names no place", () => {
    const r = placeText("Tankers diverted after drone strikes", "Two tankers diverted near Bab el-Mandeb.");
    expect(r.primary?.place.id).toBe("RED_SEA");
    expect(r.primary?.field).toBe("summary");
  });
});

describe("placeText: market words and institutions", () => {
  it("market words are not places", () => {
    expect(primaryId("Sensex falls as FIIs sell")).toBeNull();
    expect(primaryId("SEBI consultation paper proposes tighter intraday limits")).toBeNull();
  });
  it("RBI places India only with institutions on, and says so", () => {
    const m = placeText("RBI holds repo rate at 5.25%").primary!;
    expect(m.place.id).toBe("IN");
    expect(placeReason(m)).toBe("placed by 'RBI'");
    expect(primaryId("RBI holds repo rate at 5.25%", undefined, false)).toBeNull();
  });
  it("US must be the upper-case abbreviation", () => {
    expect(primaryId("US 10-year yield slides to 3.92%")).toBe("US");
    expect(primaryId("U.S. jobs report beats estimates")).toBe("US");
    expect(primaryId("All eyes on us, says the minister")).toBeNull();
    expect(primaryId("USDINR edges higher")).toBeNull();
  });
});

describe("PLACES", () => {
  it("every entry has finite coordinates and a unique id", () => {
    const ids = new Set<string>();
    for (const p of PLACES) {
      expect(Number.isFinite(p.lat) && Number.isFinite(p.lng)).toBe(true);
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(p.terms.global).toBe(false);
    }
  });
  it("includes every chokepoint", () => {
    for (const c of CHOKEPOINTS) expect(PLACES.some((p) => p.id === c.id && p.kind === "chokepoint")).toBe(true);
  });
  it("findPlaces returns one match per place", () => {
    const r = findPlaces("China and Chinese banks: China again", "title");
    expect(r.map((m) => m.place.id)).toEqual(["CN"]);
  });
});
