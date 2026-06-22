'use strict';

/**
 * ReadinessPredictionEngine - deterministic estimate of cleaning time + room
 * readiness confidence. No AI/ML: a transparent average of historical
 * durations (when available) adjusted for room type, else the task baseline.
 */

const { BASE_MINUTES } = require('../models/HousekeepingModels');

// Suites take longer; standard is the baseline.
const ROOM_TYPE_FACTOR = Object.freeze({ SUITE: 1.5, DELUXE: 1.2, STANDARD: 1.0, STD: 1.0 });

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

/**
 * @param task    { taskType, roomType }
 * @param history number[] past durations (minutes) for this task/room type
 * @param opts    { now } injectable clock (ms)
 */
function predict(task = {}, history = [], opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const base = BASE_MINUTES[task.taskType] || 20;
  const factor = ROOM_TYPE_FACTOR[(task.roomType || 'STANDARD').toUpperCase()] || 1.0;

  let estimatedMinutes;
  let confidence;
  if (Array.isArray(history) && history.length > 0) {
    const avg = history.reduce((s, n) => s + Number(n), 0) / history.length;
    estimatedMinutes = round2(avg);
    confidence = round2(Math.min(1, history.length / 5));   // 5+ samples => full confidence
  } else {
    estimatedMinutes = round2(base * factor);
    confidence = 0.5;                                       // baseline-only estimate
  }

  return {
    estimatedMinutes,
    confidence,
    predictedReadyTime: new Date(now + estimatedMinutes * 60 * 1000).toISOString()
  };
}

module.exports = { predict, ROOM_TYPE_FACTOR };
