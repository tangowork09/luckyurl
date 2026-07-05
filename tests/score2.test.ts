import { describe, expect, it } from 'vitest';
import { classifyLead, withCompetitorContext, groupKeyOf, DEFAULT_WEIGHTS } from '../src/score';
import type { Business } from '../src/types';

function biz(over: Partial<Business> = {}): Business {
  return {
    id: 'places/test-1',
    name: 'Test Cafe',
    address: '1 Main St, Bangalore',
    googleMapsUri: '',
    types: ['cafe'],
    primaryType: 'cafe',
    businessStatus: 'OPERATIONAL',
    location: { lat: 12.9758, lng: 77.6045 },
    ...over,
  };
}

describe('score reasons & value', () => {
  it('emits itemised score reasons that sum toward the score', () => {
    const lead = classifyLead(biz({ ratingCount: 400, rating: 4.6, primaryType: 'dentist', types: ['dentist'] }));
    expect(lead?.scoreReasons.length).toBeGreaterThan(1);
    const sum = lead!.scoreReasons.reduce((s, r) => s + r.points, 0);
    // score is a clamp of the sum (5..99)
    expect(lead!.leadScore).toBe(Math.min(99, Math.max(5, sum)));
  });

  it('attaches an INR value estimate', () => {
    const lead = classifyLead(biz({ primaryType: 'dentist', types: ['dentist'] }));
    expect(lead?.estValue?.label).toMatch(/^₹[\d,]+–₹[\d,]+$/);
    expect(lead!.estValue!.high).toBeGreaterThan(lead!.estValue!.low);
  });

  it('marks a quiet no-website business as easy to win', () => {
    expect(classifyLead(biz({ ratingCount: 10 }))?.winnability).toBe('easy');
  });

  it('marks a thriving 300-review shop as hard', () => {
    expect(classifyLead(biz({ ratingCount: 300, rating: 4.7 }))?.winnability).toBe('hard');
  });

  it('down-ranks a national chain', () => {
    const indie = classifyLead(biz({ name: 'Corner Cafe' }))!.leadScore;
    const chain = classifyLead(biz({ name: "Domino's Pizza Indiranagar" }))!.leadScore;
    expect(chain).toBeLessThan(indie);
  });
});

describe('withCompetitorContext', () => {
  it('adds points and a pitch angle when rivals have healthy sites', () => {
    const lead = classifyLead(biz())!;
    const before = lead.leadScore;
    const bumped = withCompetitorContext(lead, { total: 10, withHealthySite: 6 }, DEFAULT_WEIGHTS);
    expect(bumped.leadScore).toBeGreaterThan(before);
    expect(bumped.context?.withHealthySite).toBe(6);
    expect(bumped.pitchAngles.join(' ')).toMatch(/nearby/i);
  });

  it('is a no-op when no rivals have sites', () => {
    const lead = classifyLead(biz())!;
    const same = withCompetitorContext(lead, { total: 4, withHealthySite: 0 }, DEFAULT_WEIGHTS);
    expect(same.leadScore).toBe(lead.leadScore);
  });
});

describe('groupKeyOf', () => {
  it('maps a cafe to the food group', () => {
    expect(groupKeyOf(biz())).toBe('food');
  });
});

describe('review-fix regressions', () => {
  it('above-baseline category facet beats a below-baseline one', () => {
    // restaurant 1.1 + meal_takeaway 0.8 must value as a restaurant
    const lead = classifyLead(biz({ primaryType: 'restaurant', types: ['restaurant', 'meal_takeaway'] }))!;
    const takeawayOnly = classifyLead(biz({ primaryType: 'meal_takeaway', types: ['meal_takeaway'] }))!;
    expect(lead.estValue!.high).toBeGreaterThan(takeawayOnly.estValue!.high);
  });

  it('scoreReasons always sum exactly to leadScore (clamp delta recorded)', () => {
    // Closed chain forces the 5-floor clamp
    const floored = classifyLead(
      biz({ name: "Domino's Pizza", businessStatus: 'CLOSED_PERMANENTLY' }),
    )!;
    const sum = floored.scoreReasons.reduce((s, r) => s + r.points, 0);
    expect(sum).toBe(floored.leadScore);
  });
});
