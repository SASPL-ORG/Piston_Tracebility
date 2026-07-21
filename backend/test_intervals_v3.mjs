import { merge, clip, intersect, subtract, totalSeconds } from './dist/utils/intervals.js';

function eq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}    got=${JSON.stringify(a)}  want=${JSON.stringify(b)}`);
}

console.log('--- intersect (new in v3) ---');
eq(intersect([[0, 10]], [[3, 7]]), [[3, 7]], 'b inside a');
eq(intersect([[3, 7]], [[0, 10]]), [[3, 7]], 'a inside b');
eq(intersect([[0, 5]], [[3, 8]]), [[3, 5]], 'partial overlap');
eq(intersect([[0, 5]], [[5, 10]]), [], 'touching but no overlap');
eq(intersect([[0, 5], [10, 15]], [[3, 12]]), [[3, 5], [10, 12]], 'one b crosses two a');
eq(intersect([], [[0, 5]]), [], 'empty a');
eq(intersect([[0, 5]], []), [], 'empty b');
eq(
  intersect([[0, 10], [20, 30]], [[5, 25]]),
  [[5, 10], [20, 25]],
  'alarms ∩ fault — two state segments hit by one alarm window',
);
process.exit(0);
