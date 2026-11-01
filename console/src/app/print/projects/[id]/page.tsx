import Link from "next/link";

import type { Intent, ProjectDetail } from "@/lib/cairn-api";
import { formatDate, formatNumber, formatRelative, idOrdinal, oneLine } from "@/lib/cairn-format";

import { PrintTrigger } from "./print-trigger";

// The print view reads live project data on every request (cache: "no-store").
// Next must not try to prerender it as static content.
export const dynamic = "force-dynamic";

const PREMISES = new Set(["origin", "goal"]);

/**
 * `output: export` requires every dynamic route to declare its params. This
 * page reads `searchParams` (the auto-print flag), which cannot be prerendered,
 * so the static export emits no print pages; the normal server build keeps
 * rendering any project id on demand because `dynamicParams` defaults to true.
 */
export async function generateStaticParams(): Promise<{ id: string }[]> {
  return [];
}

function producerLabel(producer: Intent | undefined): string {
  if (!producer) return "bootstrap";
  return `${producer.worker ?? producer.creator} · ${producer.id}`;
}

async function loadProject(id: string): Promise<ProjectDetail | null> {
  const base = process.env.CAIRN_API ?? "http://127.0.0.1:8000";
  try {
    const response = await fetch(`${base}/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as ProjectDetail;
  } catch {
    return null;
  }
}

export default async function ProjectPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ auto?: string }>;
}) {
  const { id } = await params;
  const { auto } = await searchParams;
  const detail = await loadProject(id);

  if (!detail) {
    return (
      <div data-print-root style={{ display: "block" }} className="min-h-dvh bg-white p-10 font-sans text-neutral-900">
        <h1 className="text-xl font-semibold">Report unavailable</h1>
        <p className="mt-2 text-sm text-neutral-600">Could not load project {id} from Cairn.</p>
        <Link className="mt-4 inline-block text-sm underline" href={`/projects/${id}`}>
          Back to the project
        </Link>
      </div>
    );
  }

  const project = detail.project;
  const facts = detail.facts;
  const intents = detail.intents;
  const derivedFindings = facts.filter((fact) => !PREMISES.has(fact.id));
  const domainFindings = detail.findings ?? [];
  const entities = detail.entities ?? [];
  const retests = detail.retests ?? [];
  const coverage = detail.coverage ?? null;
  const hasDomainFindings = domainFindings.length > 0;
  const findingCount = hasDomainFindings ? domainFindings.length : derivedFindings.length;
  const producers = new Map<string, Intent>();
  for (const intent of intents) if (intent.to) producers.set(intent.to, intent);
  const allFindings = [...derivedFindings].sort((a, b) => idOrdinal(b.id) - idOrdinal(a.id));
  const allIntents = [...intents].sort(
    (a, b) => Date.parse(b.concluded_at ?? b.created_at) - Date.parse(a.concluded_at ?? a.created_at),
  );
  const origin = facts.find((fact) => fact.id === "origin");
  const goal = facts.find((fact) => fact.id === "goal");
  const open = intents.filter((intent) => !intent.concluded_at).length;

  return (
    <div data-print-root style={{ display: "block" }} className="min-h-dvh bg-white font-sans text-neutral-900">
      <style>{`
        @media print {
          @page {
            size: A4;
            margin: 14mm 14mm 18mm;
            @bottom-center {
              content: "Page " counter(page) " of " counter(pages);
              font-size: 9pt;
              color: #666;
            }
          }
          html, body {
            width: auto !important;
            height: auto !important;
            overflow: visible !important;
            background: #fff !important;
          }
          /* The shell ships a one-page in-app print root; the dedicated print
             view must be allowed to paginate its full report. */
          [data-print-root] {
            width: auto !important;
            height: auto !important;
            overflow: visible !important;
          }
          [data-print-hidden] { display: none !important; }
          thead { display: table-header-group; }
          h2 { break-after: avoid; }
        }
      `}</style>

      <div className="mx-auto max-w-4xl p-8 print:p-0">
        <div
          data-print-hidden
          className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 pb-3"
        >
          <div className="text-xs text-neutral-500">
            Dedicated print view · choose “Save as PDF” in the browser print dialog
          </div>
          <PrintTrigger auto={auto !== "0"} />
        </div>

        <header className="flex items-start justify-between gap-6 border-b border-neutral-300 pb-4">
          <div>
            <div className="text-[11px] font-semibold tracking-[0.18em] text-neutral-500">CAIRN — PROJECT REPORT</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{project.title}</h1>
            <div className="mt-1 text-xs text-neutral-500">
              {project.id} · {project.status} · created {formatDate(project.created_at)}
            </div>
          </div>
          <div className="text-right text-[11px] text-neutral-500">
            <div>Generated {formatDate(new Date().toISOString())}</div>
            <div>
              {formatNumber(findingCount)} finding{findingCount === 1 ? "" : "s"} ·{" "}
              {formatNumber(intents.length)} intent{intents.length === 1 ? "" : "s"}
            </div>
          </div>
        </header>

        <section className="mt-5 grid grid-cols-5 gap-3">
          {[
            { label: "Findings", value: findingCount },
            { label: "Entities", value: entities.length },
            { label: "Retests", value: retests.length },
            { label: "Intents", value: intents.length },
            { label: "Open intents", value: open },
          ].map((item) => (
            <div key={item.label} className="rounded border border-neutral-300 p-3">
              <div className="text-[10px] text-neutral-500">{item.label}</div>
              <div className="mt-0.5 text-xl font-semibold tabular-nums">{formatNumber(item.value)}</div>
            </div>
          ))}
        </section>

        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Objective</h2>
          <p className="mt-2 text-[12px] leading-relaxed">{goal?.description ?? "No goal recorded."}</p>
        </section>

        <section className="mt-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Scope / origin</h2>
          <p className="mt-2 text-[12px] leading-relaxed">{origin?.description ?? "No origin recorded."}</p>
        </section>

        {coverage && (coverage.denominator > 0 || entities.length > 0) && (
          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Scope and coverage</h2>
            <p className="mt-2 text-[12px] leading-relaxed">
              <strong>
                {formatNumber(coverage.tested)} / {formatNumber(coverage.denominator)}
              </strong>{" "}
              tested
              {coverage.pct !== null ? ` (${(coverage.pct * 100).toFixed(1)}%)` : ""} ·{" "}
              {formatNumber(entities.length)} entities · {formatNumber(coverage.scope_rows)} in scope
            </p>
            {coverage.by_kind.length > 0 && (
              <table className="mt-2 w-full table-fixed border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-neutral-300 text-left text-neutral-500">
                    <th className="py-1.5 pr-2 font-medium">Kind</th>
                    <th className="w-24 py-1.5 pr-2 font-medium">Tested</th>
                    <th className="w-24 py-1.5 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.by_kind.map((row) => (
                    <tr key={row.kind} className="border-b border-neutral-200">
                      <td className="py-1.5 pr-2">{row.kind}</td>
                      <td className="py-1.5 pr-2 tabular-nums">{formatNumber(row.tested)}</td>
                      <td className="py-1.5 tabular-nums">{formatNumber(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Findings</h2>
          <div className="mt-0.5 text-[10px] text-neutral-500">
            {hasDomainFindings
              ? `All ${formatNumber(domainFindings.length)} recorded findings`
              : `All ${formatNumber(derivedFindings.length)} findings, latest first`}
          </div>
          {hasDomainFindings ? (
            <table className="mt-2 w-full table-fixed border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-neutral-300 text-left text-neutral-500">
                  <th className="w-16 py-1.5 pr-2 font-medium">ID</th>
                  <th className="w-20 py-1.5 pr-2 font-medium">Severity</th>
                  <th className="w-24 py-1.5 pr-2 font-medium">Status</th>
                  <th className="py-1.5 pr-2 font-medium">Finding</th>
                  <th className="w-28 py-1.5 font-medium">Class</th>
                </tr>
              </thead>
              <tbody>
                {domainFindings.map((finding) => (
                  <tr key={finding.id} className="border-b border-neutral-200 align-top">
                    <td className="py-2 pr-2 font-mono">{finding.id}</td>
                    <td className="py-2 pr-2 capitalize">{finding.severity || "—"}</td>
                    <td className="py-2 pr-2">{finding.status.replace(/_/g, " ")}</td>
                    <td className="py-2 pr-2 leading-snug break-words [overflow-wrap:anywhere]">
                      {oneLine(finding.title)}
                      {finding.summary ? (
                        <span className="mt-0.5 block text-neutral-500">{oneLine(finding.summary)}</span>
                      ) : null}
                    </td>
                    <td className="py-2 text-neutral-500">{finding.klass || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="mt-2 w-full table-fixed border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-neutral-300 text-left text-neutral-500">
                  <th className="w-16 py-1.5 pr-2 font-medium">ID</th>
                  <th className="py-1.5 pr-2 font-medium">Description</th>
                  <th className="w-40 py-1.5 font-medium">Produced by</th>
                </tr>
              </thead>
              <tbody>
                {allFindings.map((fact) => (
                  <tr key={fact.id} className="border-b border-neutral-200 align-top">
                    <td className="py-2 pr-2 font-mono">{fact.id}</td>
                    <td className="py-2 pr-2 leading-snug break-words [overflow-wrap:anywhere]">
                      {oneLine(fact.description)}
                    </td>
                    <td className="py-2 text-neutral-500">{producerLabel(producers.get(fact.id))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {retests.length > 0 && (
          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Retests</h2>
            <table className="mt-2 w-full table-fixed border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-neutral-300 text-left text-neutral-500">
                  <th className="w-16 py-1.5 pr-2 font-medium">ID</th>
                  <th className="w-16 py-1.5 pr-2 font-medium">Finding</th>
                  <th className="w-20 py-1.5 pr-2 font-medium">Status</th>
                  <th className="w-28 py-1.5 pr-2 font-medium">Verdict</th>
                  <th className="py-1.5 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {retests.map((retest) => (
                  <tr key={retest.id} className="border-b border-neutral-200 align-top">
                    <td className="py-2 pr-2 font-mono">{retest.id}</td>
                    <td className="py-2 pr-2 font-mono">{retest.finding_id}</td>
                    <td className="py-2 pr-2">{retest.status}</td>
                    <td className="py-2 pr-2">{retest.verdict || "—"}</td>
                    <td className="py-2 leading-snug break-words [overflow-wrap:anywhere]">
                      {oneLine(retest.summary || retest.notes || "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Intents</h2>
          <div className="mt-0.5 text-[10px] text-neutral-500">
            All {formatNumber(intents.length)} intents, newest activity first
          </div>
          <table className="mt-2 w-full table-fixed border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-neutral-500">
                <th className="w-16 py-1.5 pr-2 font-medium">ID</th>
                <th className="w-20 py-1.5 pr-2 font-medium">Status</th>
                <th className="py-1.5 pr-2 font-medium">Description</th>
                <th className="w-24 py-1.5 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {allIntents.map((intent) => {
                const status = intent.concluded_at ? "concluded" : intent.worker ? "working" : "open";
                return (
                  <tr key={intent.id} className="border-b border-neutral-200 align-top">
                    <td className="py-2 pr-2 font-mono">{intent.id}</td>
                    <td className="py-2 pr-2 capitalize">{status}</td>
                    <td className="py-2 pr-2 leading-snug break-words [overflow-wrap:anywhere]">
                      {oneLine(intent.description)}
                    </td>
                    <td className="py-2 text-neutral-500">
                      {formatRelative(intent.concluded_at ?? intent.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="mt-6 border-t border-neutral-300 pt-3 text-[10px] text-neutral-500">
          Provenance: {project.id} · created {formatDate(project.created_at)} · {formatNumber(findingCount)} finding
          {findingCount === 1 ? "" : "s"} + {PREMISES.size} premises · {formatNumber(intents.length)} intent
          {intents.length === 1 ? "" : "s"} · {formatNumber(detail.hints.length)} hint
          {detail.hints.length === 1 ? "" : "s"}. Exports: YAML and timeline from the Cairn API.
        </section>
      </div>
    </div>
  );
}
