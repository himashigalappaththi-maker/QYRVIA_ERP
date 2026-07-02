'use strict';

/**
 * Deterministic rule resolver (Phase 30.1).
 *
 * Resolves the EFFECTIVE value of a date-scoped attribute (a rate modifier or a
 * restriction field) for a target context (property, room type, rate plan, date,
 * channel) from a set of rules.
 *
 * Priority order (lowest -> highest, higher WINS):
 *   system  ->  property  ->  rate_plan  ->  channel
 *
 * Conflict resolution is explicit + total (so the result is deterministic):
 *   1. higher level rank wins;
 *   2. tie -> higher `priority`;
 *   3. tie -> lexicographically greater `id`.
 *
 * A rule MATCHES a context when: same property; its scope fields (roomTypeId /
 * ratePlanId / channel), when set, equal the context (null = wildcard); the date
 * falls in the half-open window [date_from, date_to); and its `dow` (if set)
 * includes the date's day-of-week. Restriction fields resolve INDEPENDENTLY -
 * each field takes the value from the highest-precedence rule that defines it,
 * so partial rules compose predictably.
 */

const { dayOfWeek, inWindow } = require('./model');

function matches(rule, ctx) {
  if (rule.propertyId !== ctx.propertyId) return false;
  if (rule.roomTypeId != null && rule.roomTypeId !== ctx.roomTypeId) return false;
  if (rule.ratePlanId != null && rule.ratePlanId !== ctx.ratePlanId) return false;
  if (rule.channel != null && rule.channel !== ctx.channel) return false;
  if (!inWindow(ctx.date, rule.date_from, rule.date_to)) return false;
  if (rule.dow && !rule.dow.includes(dayOfWeek(ctx.date))) return false;
  return true;
}

/** Total precedence order: a wins over b => positive. */
function precedence(a, b) {
  if (a.levelRank !== b.levelRank) return a.levelRank - b.levelRank;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

/** All matching rules, ascending by precedence (last = winner). Deterministic. */
function matchingRules(rules, ctx) {
  return (rules || []).filter((r) => matches(r, ctx)).sort(precedence);
}

/** The single highest-precedence matching rule for which `defines(rule)` is true, else null. */
function winningRule(rules, ctx, defines) {
  let best = null;
  for (const r of rules || []) {
    if (!matches(r, ctx)) continue;
    if (defines && !defines(r)) continue;
    if (best === null || precedence(r, best) > 0) best = r;
  }
  return best;
}

/** Resolve a scalar restriction field by precedence; `defaultVal` when no rule defines it. */
function resolveField(rules, ctx, field, defaultVal) {
  const r = winningRule(rules, ctx, (x) => x[field] != null);
  return r ? r[field] : defaultVal;
}

module.exports = { matches, precedence, matchingRules, winningRule, resolveField };
