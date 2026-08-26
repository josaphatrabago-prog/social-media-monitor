/**
 * Inline-SVG charts. No chart library, so the dashboard works offline and
 * loads nothing from a CDN.
 *
 * The volume chart plots the server's real time buckets. The previous version
 * of this dashboard derived its bars from percentages of the running total,
 * which drew a plausible-looking curve that did not correspond to when
 * anything was actually posted.
 */

const SENTIMENT_COLORS = {
  positive: '#10b981',
  neutral: '#94a3b8',
  negative: '#f43f5e'
};

const PLATFORM_COLORS = {
  Facebook: '#4294ff',
  YouTube: '#ff4d4d',
  TikTok: '#00f2ea',
  Instagram: '#ff6699'
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function element(name, attributes = {}, textContent) {
  const node = document.createElementNS(SVG_NS, name);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }

  if (textContent !== undefined) node.textContent = String(textContent);
  return node;
}

function emptyState(container, message) {
  container.replaceChildren();
  const note = document.createElement('div');
  note.className = 'chart-empty';
  note.textContent = message;
  container.appendChild(note);
}

/* ------------------------------------------------------------------- donut */

/**
 * Sentiment split as a donut with the total in the middle.
 * @param {HTMLElement} container
 * @param {{total: number, sentiment: Object, sentimentShare: Object}} stats
 */
export function renderSentimentDonut(container, stats) {
  if (!container) return;

  if (!stats || stats.total === 0) {
    emptyState(container, 'No mentions yet');
    return;
  }

  const size = 168;
  const strokeWidth = 22;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  const svg = element('svg', {
    viewBox: `0 0 ${size} ${size}`,
    class: 'donut-svg',
    role: 'img',
    'aria-label': `Sentiment split of ${stats.total} mentions`
  });

  // Track behind the segments, so a tiny slice still reads as part of a ring.
  svg.appendChild(element('circle', {
    cx: size / 2,
    cy: size / 2,
    r: radius,
    fill: 'none',
    stroke: 'rgba(255,255,255,0.06)',
    'stroke-width': strokeWidth
  }));

  const order = ['positive', 'neutral', 'negative'];
  let offset = 0;

  for (const key of order) {
    const count = stats.sentiment[key] || 0;
    if (count === 0) continue;

    const fraction = count / stats.total;
    const segment = element('circle', {
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      stroke: SENTIMENT_COLORS[key],
      'stroke-width': strokeWidth,
      'stroke-dasharray': `${fraction * circumference} ${circumference}`,
      'stroke-dashoffset': -offset,
      // Rotate so the ring starts at 12 o'clock rather than 3 o'clock.
      transform: `rotate(-90 ${size / 2} ${size / 2})`
    });

    segment.appendChild(element('title', {}, `${key}: ${count} (${stats.sentimentShare[key]}%)`));
    svg.appendChild(segment);
    offset += fraction * circumference;
  }

  svg.appendChild(element('text', {
    x: size / 2,
    y: size / 2 - 4,
    'text-anchor': 'middle',
    class: 'donut-total'
  }, stats.total));

  svg.appendChild(element('text', {
    x: size / 2,
    y: size / 2 + 16,
    'text-anchor': 'middle',
    class: 'donut-label'
  }, stats.total === 1 ? 'mention' : 'mentions'));

  const legend = document.createElement('div');
  legend.className = 'chart-legend';

  for (const key of order) {
    const row = document.createElement('div');
    row.className = 'chart-legend-row';
    row.innerHTML =
      `<span class="legend-swatch" style="background:${SENTIMENT_COLORS[key]}"></span>` +
      `<span class="legend-name">${key}</span>` +
      `<span class="legend-value">${stats.sentiment[key] || 0} · ${stats.sentimentShare[key]}%</span>`;
    legend.appendChild(row);
  }

  container.replaceChildren(svg, legend);
}

/* -------------------------------------------------------------- share bars */

/**
 * @param {HTMLElement} container
 * @param {Array<{platform: string, count: number, share: number}>} platforms
 */
export function renderPlatformBars(container, platforms) {
  if (!container) return;

  if (!platforms || platforms.length === 0) {
    emptyState(container, 'No platform data yet');
    return;
  }

  const maxCount = Math.max(...platforms.map((entry) => entry.count), 1);
  const fragment = document.createDocumentFragment();

  for (const entry of platforms) {
    const row = document.createElement('div');
    row.className = 'share-row';

    const label = document.createElement('div');
    label.className = 'share-label';
    label.innerHTML =
      `<span class="share-name">${entry.platform}</span>` +
      `<span class="share-value">${entry.count} · ${entry.share}%</span>`;

    const track = document.createElement('div');
    track.className = 'share-track';

    const fill = document.createElement('div');
    fill.className = 'share-fill';
    // Scaled against the busiest platform, so the leader always fills the bar.
    fill.style.width = `${Math.max(2, (entry.count / maxCount) * 100)}%`;
    fill.style.background = PLATFORM_COLORS[entry.platform] || 'var(--accent-primary)';

    track.appendChild(fill);
    row.append(label, track);
    fragment.appendChild(row);
  }

  container.replaceChildren(fragment);
}

/* ------------------------------------------------------------ volume chart */

function formatBucketTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Stacked bars of real mention volume per time bucket.
 * @param {HTMLElement} container
 * @param {{bucketMinutes: number, buckets: Array}} timeline
 */
export function renderVolumeChart(container, timeline) {
  if (!container) return;

  const buckets = timeline?.buckets || [];
  if (buckets.length === 0) {
    emptyState(container, 'No activity yet');
    return;
  }

  const maxTotal = Math.max(...buckets.map((bucket) => bucket.total), 1);
  const hasAny = buckets.some((bucket) => bucket.total > 0);

  const width = 100;
  const height = 42;
  const gap = 0.6;
  const barWidth = Math.max(0.8, (width - gap * (buckets.length - 1)) / buckets.length);

  const svg = element('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    class: 'volume-svg',
    role: 'img',
    'aria-label': `Mention volume per ${timeline.bucketMinutes} minutes`
  });

  buckets.forEach((bucket, index) => {
    const x = index * (barWidth + gap);
    const label = `${formatBucketTime(bucket.start)} — ${bucket.total} mention(s)` +
      (bucket.total
        ? ` (${bucket.positive} pos, ${bucket.neutral} neu, ${bucket.negative} neg)`
        : '');

    if (bucket.total === 0) {
      // A visible baseline tick reads as "nothing happened", not "no data".
      const baseline = element('rect', {
        x, y: height - 0.6, width: barWidth, height: 0.6,
        fill: 'rgba(255,255,255,0.10)'
      });
      baseline.appendChild(element('title', {}, label));
      svg.appendChild(baseline);
      return;
    }

    const totalHeight = (bucket.total / maxTotal) * (height - 2);
    let y = height - totalHeight;

    // Stack order puts negatives on top, where a spike is most visible.
    for (const key of ['positive', 'neutral', 'negative']) {
      const count = bucket[key] || 0;
      if (count === 0) continue;

      const segmentHeight = (count / bucket.total) * totalHeight;
      const rect = element('rect', {
        x,
        y,
        width: barWidth,
        height: segmentHeight,
        fill: SENTIMENT_COLORS[key]
      });

      rect.appendChild(element('title', {}, label));
      svg.appendChild(rect);
      y += segmentHeight;
    }
  });

  const axis = document.createElement('div');
  axis.className = 'volume-axis';

  const firstLabel = document.createElement('span');
  firstLabel.textContent = formatBucketTime(buckets[0].start);

  const scaleLabel = document.createElement('span');
  scaleLabel.className = 'volume-scale';
  scaleLabel.textContent = hasAny
    ? `peak ${maxTotal} / ${timeline.bucketMinutes}m`
    : `${timeline.bucketMinutes}m buckets`;

  const lastLabel = document.createElement('span');
  lastLabel.textContent = 'now';

  axis.append(firstLabel, scaleLabel, lastLabel);
  container.replaceChildren(svg, axis);
}

export { SENTIMENT_COLORS, PLATFORM_COLORS };
