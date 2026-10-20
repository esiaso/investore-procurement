/**
 * Tender evaluation:
 * 1. Preliminary (pass/fail per mandatory criterion, majority of the members);
 *    a bid failing any criterion is non-responsive.
 * 2. Technical: each member's score = Σ score / maxScore × weight (out of 100);
 *    the bid's technical score is the members' average. Below the pass mark the
 *    bid is technically failed. No technical criteria = everyone scores 100.
 * 3. Financial: among technically qualified bids, financial score =
 *    100 × lowest price / bid price.
 * 4. Combined = technical × w + financial × (100 − w), w = technical weight (%).
 *    w = 0 means lowest evaluated price. Ties go to the lower price.
 */
export interface EvalBid {
  id: string;
  totalPrice: number;
}
export interface EvalCriterion {
  id: string;
  stage: 'PRELIMINARY' | 'TECHNICAL' | 'FINANCIAL';
  weight: number;
  maxScore: number;
}
export interface EvalScore {
  criterionId: string;
  bidId: string;
  memberId: string;
  score: number;
}
export interface EvalResult {
  bidId: string;
  responsive: boolean;
  failedCriteria: string[];
  technicalScore: number | null;
  qualified: boolean;
  financialScore: number | null;
  combinedScore: number | null;
  rank: number | null;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function evaluateBids(input: { bids: EvalBid[]; members: string[]; criteria: EvalCriterion[]; scores: EvalScore[]; technicalWeight: number; technicalPassMark: number }): EvalResult[] {
  const prelim = input.criteria.filter((c) => c.stage === 'PRELIMINARY');
  const tech = input.criteria.filter((c) => c.stage === 'TECHNICAL');
  const score = (c: string, b: string, m: string) => input.scores.find((s) => s.criterionId === c && s.bidId === b && s.memberId === m)?.score;
  const results: EvalResult[] = input.bids.map((b) => {
    const failed = prelim.filter((c) => {
      const votes = input.members.map((m) => score(c.id, b.id, m)).filter((v) => v !== undefined) as number[];
      const passes = votes.filter((v) => v >= 1).length;
      return votes.length === 0 || passes * 2 <= votes.length;
    });
    const responsive = failed.length === 0;
    let technicalScore: number | null = null;
    if (responsive) {
      if (!tech.length) technicalScore = 100;
      else {
        const perMember = input.members
          .map((m) => {
            const parts = tech.map((c) => {
              const v = score(c.id, b.id, m);
              return v === undefined ? null : (Math.min(v, c.maxScore) / c.maxScore) * c.weight;
            });
            return parts.some((p) => p === null) ? null : parts.reduce<number>((a, p) => a + (p ?? 0), 0);
          })
          .filter((x): x is number => x !== null);
        technicalScore = perMember.length ? r4(perMember.reduce((a, x) => a + x, 0) / perMember.length) : 0;
      }
    }
    const qualified = responsive && technicalScore !== null && technicalScore >= input.technicalPassMark;
    return { bidId: b.id, responsive, failedCriteria: failed.map((c) => c.id), technicalScore, qualified, financialScore: null, combinedScore: null, rank: null };
  });
  const qualified = results.filter((r) => r.qualified);
  const price = (id: string) => input.bids.find((b) => b.id === id)!.totalPrice;
  const lowest = Math.min(...qualified.map((r) => price(r.bidId)).filter((p) => p > 0));
  const w = input.technicalWeight;
  for (const r of qualified) {
    const p = price(r.bidId);
    r.financialScore = p > 0 && Number.isFinite(lowest) ? r4((100 * lowest) / p) : 0;
    r.combinedScore = r4((r.technicalScore! * w + r.financialScore * (100 - w)) / 100);
  }
  [...qualified]
    .sort((a, b) => b.combinedScore! - a.combinedScore! || price(a.bidId) - price(b.bidId))
    .forEach((r, i) => (r.rank = i + 1));
  return results;
}

/** Members who must score: declared, no conflict. */
export function scoringMembers(members: { id: string; declaredAt: Date | null; hasConflict: boolean | null }[]) {
  return members.filter((m) => m.declaredAt && m.hasConflict === false).map((m) => m.id);
}
