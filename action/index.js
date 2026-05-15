/**
 * GitHub Action entry point for Code Review Assistant
 *
 * Fetches PR files via GitHub API, runs the extension's analysis rules,
 * and posts a formatted comment summarising all issues found.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeCode } from '../dist/analyzer.js';
import { getAllRules } from '../dist/rules/index.js';

// ------- language detection (mirrors utils/language.ts) -------------------

const EXTENSION_TO_LANGUAGE = {
  html: 'html', htm: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  cs: 'csharp',
  svelte: 'svelte',
};

function detectLanguage(filePath) {
  const m = filePath.match(/\.([^.]+)$/);
  return m ? (EXTENSION_TO_LANGUAGE[m[1].toLowerCase()] ?? null) : null;
}

// ------- comment formatting ------------------------------------------------

const SEVERITY_ICON = { critical: '🔴', warning: '⚠️', info: 'ℹ️' };
const COMMENT_MARKER = '<!-- code-review-assistant-report -->';

function buildComment(fileResults, summary) {
  const lines = [COMMENT_MARKER, '## 🔍 Code Review Assistant\n'];

  if (summary.total === 0) {
    lines.push('✅ **No issues found** — great work!');
    return lines.join('\n');
  }

  lines.push(
    `| Severity | Count |`,
    `|----------|------:|`,
    `| 🔴 Critical | ${summary.critical} |`,
    `| ⚠️  Warning  | ${summary.warning} |`,
    `| ℹ️  Info     | ${summary.info} |`,
    `| **Total**   | **${summary.total}** |`,
    '',
  );

  for (const file of fileResults) {
    if (file.results.length === 0) continue;
    lines.push(
      `<details>`,
      `<summary><strong>${file.filePath}</strong> &nbsp;—&nbsp; ${file.results.length} issue(s)</summary>`,
      '',
      '| Line | Severity | Rule | Message |',
      '|-----:|----------|------|---------|',
    );
    for (const issue of file.results) {
      const icon = SEVERITY_ICON[issue.severity] ?? '';
      const msg = issue.message.replace(/\|/g, '\\|');
      lines.push(
        `| ${issue.lineNumber} | ${icon} ${issue.severity} | \`${issue.ruleId}\` | ${msg} |`,
      );
    }
    lines.push('', '</details>', '');
  }

  lines.push('---', '_Powered by [GitHub Code Review Assistant](https://github.com/marketplace)_');
  return lines.join('\n');
}

// ------- severity filtering ------------------------------------------------

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

function meetsThreshold(severity, threshold) {
  return (SEVERITY_RANK[severity] ?? 0) >= (SEVERITY_RANK[threshold] ?? 0);
}

// ------- diff line mapping -------------------------------------------------

/**
 * Parse a unified diff patch and return the Set of new-file line numbers
 * that appear in the diff (added lines + context lines).
 * Only lines in this set can receive inline review comments.
 *
 * @param {string|undefined} patch  The `patch` field from pulls.listFiles
 * @returns {Set<number>}
 */
function parsePatchLines(patch) {
  if (!patch) return new Set();
  const visible = new Set();
  let newLine = 0;

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      // e.g.  @@ -10,7 +12,9 @@
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLine = parseInt(m[1], 10) - 1;
    } else if (line.startsWith('-')) {
      // removed line — no new-file line number, skip
    } else if (line.startsWith('+')) {
      newLine++;
      visible.add(newLine);
    } else {
      // context line
      newLine++;
      visible.add(newLine);
    }
  }

  return visible;
}

// ------- inline comment formatting ----------------------------------------

const INLINE_MARKER = '<!-- cra-inline -->';

/**
 * Build the markdown body for a single inline review comment.
 *
 * Format:
 *   <!-- cra-inline -->
 *   🔴 **Critical** &nbsp;·&nbsp; `JS-SEC-001`
 *
 *   **eval() function call detected.** — Avoid eval() entirely…
 *
 * @param {{ ruleId: string, severity: string, message: string, remediation?: string }} issue
 * @returns {string}
 */
function buildInlineCommentBody(issue) {
  const icon = SEVERITY_ICON[issue.severity] ?? '';
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  const remediation = issue.remediation ? ` — ${issue.remediation}` : '';
  const ruleId = issue.ruleId ?? 'unknown';
  const message = issue.message || '(no message)';
  return [
    INLINE_MARKER,
    `${icon} **${cap(issue.severity)}** &nbsp;·&nbsp; \`${ruleId}\``,
    '',
    `**${message}**${remediation}`,
  ].join('\n');
}

// ------- inline comment cleanup --------------------------------------------

/**
 * Delete all existing inline review comments posted by this action
 * (identified by INLINE_MARKER in body) to prevent duplicates on re-runs.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 */
async function cleanupInlineComments(octokit, owner, repo, prNumber) {
  const existing = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner, repo, pull_number: prNumber,
  });

  const stale = existing.filter(c => c.body?.includes(INLINE_MARKER));
  core.info(`Deleting ${stale.length} stale inline comment(s)…`);

  await Promise.all(
    stale.map(c =>
      octokit.rest.pulls.deleteReviewComment({ owner, repo, comment_id: c.id }),
    ),
  );
}

// ------- inline review posting ---------------------------------------------

/**
 * Collect inline comments across all analyzed files and post them as a
 * single pull request review.  Issues whose line number falls outside the
 * diff are silently skipped here (they still appear in the summary comment).
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {string} commitSha  pr.head.sha
 * @param {Array<{ filePath: string, patch: string|undefined, results: Array }>} fileResults
 */
async function postInlineReview(octokit, owner, repo, prNumber, commitSha, fileResults) {
  const comments = [];

  for (const file of fileResults) {
    const diffLines = parsePatchLines(file.patch);

    for (const issue of file.results) {
      if (!diffLines.has(issue.lineNumber)) continue;

      comments.push({
        path: file.filePath,
        line: issue.lineNumber,
        side: 'RIGHT',
        body: buildInlineCommentBody(issue),
      });
    }
  }

  if (comments.length === 0) {
    core.info('No inline comments to post (no issues fall within diff lines).');
    return;
  }

  core.info(`Posting ${comments.length} inline comment(s) via PR review…`);

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: 'COMMENT',
      comments,
    });
  } catch (err) {
    core.warning(`Could not post inline review comments: ${err.message}`);
  }
}

// ------- label management --------------------------------------------------

async function ensureLabelExists(octokit, owner, repo, labelName) {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: labelName });
  } catch (err) {
    if (err.status === 404) {
      await octokit.rest.issues.createLabel({
        owner, repo, name: labelName, color: 'e11d48',
        description: 'PR has critical issues that need to be addressed',
      });
      core.info(`Created label "${labelName}"`);
    } else {
      throw err;
    }
  }
}

async function syncCriticalLabel(octokit, owner, repo, prNumber, labelName, hasCriticals) {
  if (!labelName) return;

  const currentLabels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
    owner, repo, issue_number: prNumber,
  });
  const hasLabel = currentLabels.some(l => l.name === labelName);

  if (hasCriticals && !hasLabel) {
    await ensureLabelExists(octokit, owner, repo, labelName);
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [labelName] });
    core.info(`Added label "${labelName}" to PR #${prNumber}`);
  } else if (!hasCriticals && hasLabel) {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: prNumber, name: labelName });
    core.info(`Removed label "${labelName}" from PR #${prNumber}`);
  }
}

// ------- security context config ------------------------------------------

const CONFIG_PATH = '.security/config.json';

const DEFAULT_CONFIG = {
  // Glob-ish substrings that mark a path as test / fixture / vendored.
  // Findings in these paths are suppressed by default.
  suppressPaths: [
    '/__tests__/', '/__mocks__/', '/test/', '/tests/', '/spec/',
    '/fixtures/', '/fixture/', '/vendor/', '/node_modules/',
    '/dist/', '/build/', '/.next/', '/coverage/',
    '.test.', '.spec.', '.stories.', '.fixture.',
  ],
  // Path substrings that indicate an attack-surface entry point — findings
  // here are bumped one severity level (info→warning, warning→critical).
  attackSurfacePaths: [
    '/controllers/', '/controller/', '/routes/', '/route/',
    '/handlers/', '/handler/', '/api/', '/pages/api/',
    '/middleware/', '/endpoints/', '/webhooks/',
  ],
  // Rule IDs to suppress entirely.
  ignoreRules: [],
  // { ruleId: severity } — pin a rule to a specific severity (overrides bump).
  ruleSeverityOverrides: {},
};

function loadConfig(workspace) {
  const full = path.join(workspace, CONFIG_PATH);
  if (!fs.existsSync(full)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(fs.readFileSync(full, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (err) {
    core.warning(`Could not parse ${CONFIG_PATH}: ${err.message} — using defaults.`);
    return DEFAULT_CONFIG;
  }
}

// ------- suppression -------------------------------------------------------

function pathMatchesAny(filePath, needles) {
  const normalized = '/' + filePath.replace(/\\/g, '/');
  return needles.some(n => normalized.includes(n));
}

function isCommentLine(line, language) {
  if (!line) return false;
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (language === 'html') return trimmed.startsWith('<!--');
  if (language === 'css') return trimmed.startsWith('/*') || trimmed.startsWith('*');
  // js/ts/cs/svelte
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

function suppressFinding(issue, file, config, codeLines) {
  if (config.ignoreRules.includes(issue.ruleId)) return 'ignored-rule';
  if (pathMatchesAny(file.filePath, config.suppressPaths)) return 'suppressed-path';
  const line = codeLines[issue.lineNumber - 1];
  if (isCommentLine(line, file.language)) return 'comment-line';
  return null;
}

// ------- cross-rule dedup --------------------------------------------------

const SEVERITY_ORDER = ['info', 'warning', 'critical'];

/**
 * Collapse multiple findings on the same line whose messages overlap
 * (e.g. several secrets-* rules hitting the same token). Keeps the
 * highest-severity issue and records the collapsed ruleIds.
 */
function collapseSameLine(results) {
  const byLine = new Map();
  for (const r of results) {
    const key = r.lineNumber;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(r);
  }

  const out = [];
  for (const [, group] of byLine) {
    if (group.length === 1) { out.push(group[0]); continue; }

    // Bucket by rule "family" (prefix before first dash group, e.g. SECRETS, JS-SEC).
    const families = new Map();
    for (const r of group) {
      const fam = (r.ruleId || '').split('-').slice(0, 2).join('-') || r.ruleId;
      if (!families.has(fam)) families.set(fam, []);
      families.get(fam).push(r);
    }

    for (const [, fam] of families) {
      fam.sort((a, b) =>
        SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity));
      const winner = fam[0];
      if (fam.length > 1) {
        winner._collapsedRuleIds = fam.slice(1).map(r => r.ruleId);
      }
      out.push(winner);
    }
  }
  return out.sort((a, b) => a.lineNumber - b.lineNumber);
}

// ------- attack-surface reweighting ----------------------------------------

function bumpSeverity(sev) {
  const i = SEVERITY_ORDER.indexOf(sev);
  if (i < 0 || i === SEVERITY_ORDER.length - 1) return sev;
  return SEVERITY_ORDER[i + 1];
}

function reweight(issue, file, config) {
  const pinned = config.ruleSeverityOverrides[issue.ruleId];
  if (pinned) return { ...issue, severity: pinned };
  if (pathMatchesAny(file.filePath, config.attackSurfacePaths)) {
    const bumped = bumpSeverity(issue.severity);
    if (bumped !== issue.severity) {
      return {
        ...issue,
        severity: bumped,
        message: issue.message + ' _(attack-surface path — severity bumped)_',
      };
    }
  }
  return issue;
}

// ------- metrics -----------------------------------------------------------

function writeMetrics(workspace, metrics) {
  try {
    const out = path.join(workspace, 'code-review-metrics.json');
    fs.writeFileSync(out, JSON.stringify(metrics, null, 2));
    core.info(`Wrote metrics to ${out}`);
  } catch (err) {
    core.warning(`Could not write metrics file: ${err.message}`);
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      const lines = [
        '## Code Review Assistant — run metrics',
        '',
        `- Files analyzed: **${metrics.filesAnalyzed}**`,
        `- Raw findings: **${metrics.rawCount}**`,
        `- Suppressed: **${metrics.suppressedCount}** (path: ${metrics.suppressedByReason['suppressed-path'] || 0}, comment: ${metrics.suppressedByReason['comment-line'] || 0}, ignored-rule: ${metrics.suppressedByReason['ignored-rule'] || 0})`,
        `- Collapsed (cross-rule dedup): **${metrics.collapsedCount}**`,
        `- Severity bumps (attack-surface): **${metrics.bumpedCount}**`,
        `- Final: ${metrics.final.critical} critical · ${metrics.final.warning} warning · ${metrics.final.info} info`,
        '',
      ];
      fs.appendFileSync(summary, lines.join('\n'));
    } catch (err) {
      core.warning(`Could not write step summary: ${err.message}`);
    }
  }
}

// ------- main action -------------------------------------------------------

async function run() {
  try {
    const token = core.getInput('github-token', { required: true });
    const failOnCritical = core.getInput('fail-on-critical') === 'true';
    const severityThreshold = core.getInput('severity-threshold') || 'info';
    const labelOnCritical = core.getInput('label-on-critical');

    const octokit = github.getOctokit(token);
    const ctx = github.context;

    if (!ctx.payload.pull_request) {
      core.info('Not a pull request — skipping analysis.');
      return;
    }

    const pr = ctx.payload.pull_request;
    const { owner, repo } = ctx.repo;
    const prNumber = pr.number;
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const config = loadConfig(workspace);

    core.info(`Analyzing PR #${prNumber} (${owner}/${repo})…`);

    // Fetch changed files (GitHub API pages at 100 per call)
    const changedFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner, repo, pull_number: prNumber, per_page: 100,
    });

    const allRules = getAllRules();
    const allFileResults = [];
    const metrics = {
      filesAnalyzed: 0,
      rawCount: 0,
      suppressedCount: 0,
      suppressedByReason: {},
      collapsedCount: 0,
      bumpedCount: 0,
      final: { critical: 0, warning: 0, info: 0 },
    };

    for (const file of changedFiles) {
      if (file.status === 'removed') continue;

      const language = detectLanguage(file.filename);
      if (!language) {
        core.debug(`Skipping ${file.filename} — unsupported extension`);
        continue;
      }

      core.info(`  Analyzing ${file.filename} (${language})`);

      let code;
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner, repo, path: file.filename, ref: pr.head.sha,
        });
        if (Array.isArray(data) || data.type !== 'file') continue;
        code = Buffer.from(data.content, 'base64').toString('utf-8');
      } catch (err) {
        core.warning(`Could not fetch ${file.filename}: ${err.message}`);
        continue;
      }

      metrics.filesAnalyzed++;

      const rawResults = analyzeCode(code, language, allRules, file.filename);
      metrics.rawCount += rawResults.results.length;

      // ---- pipeline: suppress -> collapse -> reweight -> threshold ----
      const codeLines = code.split('\n');
      const fileMeta = { filePath: file.filename, language };

      const surviving = [];
      for (const issue of rawResults.results) {
        const reason = suppressFinding(issue, fileMeta, config, codeLines);
        if (reason) {
          metrics.suppressedCount++;
          metrics.suppressedByReason[reason] = (metrics.suppressedByReason[reason] || 0) + 1;
          continue;
        }
        surviving.push(issue);
      }

      const beforeCollapse = surviving.length;
      const collapsed = collapseSameLine(surviving);
      metrics.collapsedCount += beforeCollapse - collapsed.length;

      const reweighted = collapsed.map(r => {
        const next = reweight(r, fileMeta, config);
        if (next.severity !== r.severity) metrics.bumpedCount++;
        return next;
      });

      const final = reweighted.filter(r => meetsThreshold(r.severity, severityThreshold));
      if (final.length === 0) continue;

      rawResults.results = final;
      rawResults.patch = file.patch;
      allFileResults.push(rawResults);

      for (const r of final) {
        if (r.severity === 'critical') metrics.final.critical++;
        else if (r.severity === 'warning') metrics.final.warning++;
        else metrics.final.info++;
      }
    }

    const criticalCount = metrics.final.critical;
    const warningCount = metrics.final.warning;
    const infoCount = metrics.final.info;

    const summary = {
      total: criticalCount + warningCount + infoCount,
      critical: criticalCount,
      warning: warningCount,
      info: infoCount,
    };

    core.info(`Analysis complete: ${summary.total} issue(s) found (${criticalCount} critical, ${warningCount} warning, ${infoCount} info)`);
    core.info(`Pipeline: raw=${metrics.rawCount} suppressed=${metrics.suppressedCount} collapsed=${metrics.collapsedCount} bumped=${metrics.bumpedCount}`);
    writeMetrics(workspace, metrics);

    // Post inline review comments on diff lines
    try {
      await cleanupInlineComments(octokit, owner, repo, prNumber);
    } catch (err) {
      core.warning(`Could not clean up stale inline comments: ${err.message}`);
    }
    await postInlineReview(octokit, owner, repo, prNumber, pr.head.sha, allFileResults);

    // Post or update PR comment
    const commentBody = buildComment(allFileResults, summary);

    const existingComments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number: prNumber,
    });

    const botComment = existingComments.find(c =>
      c.user?.type === 'Bot' && c.body?.includes(COMMENT_MARKER),
    );

    if (botComment) {
      await octokit.rest.issues.updateComment({
        owner, repo, comment_id: botComment.id, body: commentBody,
      });
      core.info('Updated existing review comment.');
    } else {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body: commentBody,
      });
      core.info('Posted new review comment.');
    }

    // Action outputs
    core.setOutput('total-issues', String(summary.total));
    core.setOutput('critical-issues', String(summary.critical));
    core.setOutput('warning-issues', String(summary.warning));

    // Manage PR label based on critical findings
    await syncCriticalLabel(octokit, owner, repo, prNumber, labelOnCritical, criticalCount > 0);

    if (failOnCritical && criticalCount > 0) {
      core.setFailed(`Found ${criticalCount} critical issue(s) — please review before merging.`);
    }
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
