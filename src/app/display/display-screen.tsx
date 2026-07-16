"use client";

import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { DisplayState } from "@/lib/lodge-display-state";
import type {
  DisplayRegionDefinition,
  DisplayTemplateDefinition,
} from "@/lib/lodge-display/template-registry";
import {
  DEFAULT_DISPLAY_TEMPLATE_KEY,
  DEFAULT_ROTATE_SECONDS,
  eligibleDisplayPanels,
  listBuiltInDisplayTemplates,
} from "@/lib/lodge-display/template-registry";
import {
  DISPLAY_AREA_MARKER_ATTR,
  DISPLAY_MODULE_MARKER_ATTR,
  type DisplayAreaDefinition,
  type LayoutRenderPayload,
  type SlotContent,
} from "@/lib/lodge-display/layout-registry";
import { DISPLAY_AUTHORED_ROOT_CLASS } from "@/lib/lodge-display/css-tokens";
import type { DisplayModuleName } from "@/lib/lodge-display/template-registry";
import { evaluateDisplayCondition } from "@/lib/lodge-display/conditions";
import { resolveDisplayText } from "@/lib/lodge-display/display-text";
import {
  DISPLAY_MODULE_COMPONENTS,
  type DisplayModuleProps,
} from "@/components/lodge-display/modules";
import { useDisplayState, type DisplayPayload } from "./use-display-state";

// The lobby display screen (fork issue #32): full-screen, non-interactive,
// driven entirely by the display-state payload + resolved template. States:
// pairing (show the code, poll claim), active (render regions, rotate
// eligible panels), stale (keep the last good render, badge it).

function formatClock(date: Date): string {
  return date
    .toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })
    .toUpperCase();
}

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Preview-mode state for the header (issue #60): whether the URL marks this
 * as an admin preview, and any active simulated date. Computed after mount so
 * the server render and first client render match (the page is force-dynamic
 * and client-hydrated). */
function readPreviewState(): { isPreview: boolean; previewDate: string | null } {
  if (typeof window === "undefined") return { isPreview: false, previewDate: null };
  const params = new URLSearchParams(window.location.search);
  // A sandboxed authoring-page embed carries ?previewGrant (LTV-036) instead of
  // ?preview/?previewDevice, but it is still a preview: the clock's simulate
  // affordance and the "previewing against" line belong there too.
  const isPreview =
    params.has("preview") ||
    params.has("previewDevice") ||
    params.has("previewGrant");
  const raw = params.get("previewDate");
  const previewDate = raw && DATE_ONLY_REGEX.test(raw) ? raw : null;
  return { isPreview, previewDate };
}

/** Human-readable label for the accessible simulating hint; falls back to the
 * raw value if it is not a real calendar date. */
function formatSimulatedDate(dateStr: string): string {
  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateStr;
  return parsed.toLocaleDateString("en-NZ", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Live clock + payload freshness for the header (issue #56). Ticks on the
 * client only; the server render shows a blank slot for one frame. In an admin
 * preview (issue #60) the date line becomes a date picker that rewrites
 * ?previewDate and reloads — a testing tool, so a full reload is fine. While a
 * previewDate is active the clock recolours amber (data-simulated) and its date
 * line shows the simulated window start instead of today; the layout never
 * shifts. The rendered lodge is identified on the admin preview host page
 * around the frame (LTV-036), so no in-frame "previewing against" line is
 * needed — a preview always renders the lodge the device or template is bound
 * to. */
function HeaderClock({
  generatedAt,
  windowStart,
}: {
  generatedAt: string;
  windowStart: string;
}) {
  const [now, setNow] = useState<Date | null>(null);
  const [preview, setPreview] = useState(() => ({
    isPreview: false,
    previewDate: null as string | null,
  }));
  const dateInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setNow(new Date());
    setPreview(readPreviewState());
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!now) return <div className="display-header-clock" />;
  const updated = new Date(generatedAt);
  const simulated = preview.isPreview && preview.previewDate !== null;

  const applyPreviewDate = (value: string) => {
    if (!DATE_ONLY_REGEX.test(value)) return;
    const params = new URLSearchParams(window.location.search);
    params.set("previewDate", value);
    // A testing tool: a full reload keeps the fetch/render path identical to a
    // fresh preview open.
    window.location.search = params.toString();
  };

  const openPicker = () => {
    const input = dateInputRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus();
      input.click();
    }
  };

  // The date line shows real "today" normally; when a previewDate override is
  // active it shows the simulated window start (the board's window.start),
  // keeping the header and the board in agreement without shifting layout.
  const dateSource = simulated ? new Date(`${windowStart}T00:00:00`) : now;
  const dateLine = (
    <>
      {dateSource.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" })}
      {" · "}
      <b>updated {formatClock(updated).toLowerCase()}</b>
    </>
  );

  return (
    <div
      className="display-header-clock"
      data-simulated={simulated ? "" : undefined}
    >
      <span className="display-clock-time">{formatClock(now)}</span>
      {preview.isPreview ? (
        // #65 fix: the date <input> is a SIBLING of the button, not its child.
        // A native date input nested inside a <button> is invalid HTML and its
        // selection does not reliably fire `change`, so picking a date never
        // applied; as siblings the picker fires normally and the button just
        // opens it via showPicker() on the shared ref (focus/click fallback).
        <>
          <button
            type="button"
            className="display-clock-date display-clock-date-picker"
            onClick={openPicker}
          >
            {dateLine}
          </button>
          <input
            ref={dateInputRef}
            type="date"
            className="display-simulate-input"
            defaultValue={preview.previewDate ?? ""}
            onChange={(event) => applyPreviewDate(event.target.value)}
            aria-label="Simulate a date"
          />
        </>
      ) : (
        <span className="display-clock-date">{dateLine}</span>
      )}
      {simulated && (
        <span className="display-visually-hidden">
          Simulating {formatSimulatedDate(preview.previewDate as string)}
        </span>
      )}
    </div>
  );
}

function LodgeHeader({ state }: DisplayModuleProps) {
  return (
    <div className="display-lodge-header">
      <div className="display-header-brand">
        {state.club.logoDataUrl && (
          // Decorative: the lodge name (and club name, when set) render as
          // adjacent visible text below, so an alt here would be redundant.
          // Empty alt is the correct WCAG treatment (#1947).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="display-header-logo"
            src={state.club.logoDataUrl}
            alt=""
          />
        )}
        <div>
          <div className="display-lodge-name">{state.lodge.name}</div>
          {state.club.name && (
            <div className="display-club-name">{state.club.name}</div>
          )}
        </div>
      </div>
      <HeaderClock
        generatedAt={state.generatedAt}
        windowStart={state.window.start}
      />
    </div>
  );
}

function InfoFooter({ state }: DisplayModuleProps) {
  const wifiName = state.config["wifi-name"];
  const wifiCode = state.config["wifi-code"];
  const email = state.config["contact-email"];
  const note = state.config["footer-note"];
  return (
    <div className="display-info-footer">
      {wifiCode && (
        <span className="display-footer-item">
          <span className="display-footer-icon">📶</span>
          Wi-Fi {wifiName && <b>{wifiName}</b>} · <b>{wifiCode}</b>
        </span>
      )}
      {email && (
        <span className="display-footer-item">
          <span className="display-footer-icon">✉</span>
          <b>{email}</b>
        </span>
      )}
      {note && (
        <span className="display-footer-note">{resolveDisplayText(note, state)}</span>
      )}
    </div>
  );
}

// Header/footer are page furniture, delivered with the page itself; the
// booking/chore modules arrived in LTV-005/006 and notice-board in LTV-011.
const PAGE_MODULE_COMPONENTS = {
  ...DISPLAY_MODULE_COMPONENTS,
  "lodge-header": LodgeHeader,
  "info-footer": InfoFooter,
};

function Panel({
  panel,
  state,
}: {
  panel: DisplayRegionDefinition["panels"][number];
  state: DisplayState;
}) {
  const Module =
    PAGE_MODULE_COMPONENTS[panel.module as keyof typeof PAGE_MODULE_COMPONENTS];
  if (!Module) {
    // A template referencing a module that has no renderer yet degrades
    // to a neutral placeholder — never a crash on a lobby wall.
    return <div className="display-module-placeholder" data-module={panel.module} />;
  }
  return <Module state={state} options={panel.options} />;
}

function Region({
  region,
  state,
}: {
  region: DisplayRegionDefinition;
  state: DisplayState;
}) {
  const panels = eligibleDisplayPanels(region, state);
  const rotates = region.layout !== "stack";
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!rotates || panels.length <= 1) return;
    const seconds = region.rotateSeconds ?? DEFAULT_ROTATE_SECONDS;
    const timer = setInterval(
      () => setIndex((current) => current + 1),
      seconds * 1000
    );
    return () => clearInterval(timer);
  }, [rotates, panels.length, region.rotateSeconds]);

  if (panels.length === 0) return <div className={`display-region display-region-${region.key}`} />;

  // "stack" (issue #56): every eligible panel at once — the sidebar-card
  // treatment; "rotate" (default): one panel at a time on the region timer.
  if (!rotates) {
    return (
      <div className={`display-region display-region-${region.key} display-region-stack`}>
        {panels.map((panel, panelIndex) => (
          <Panel key={`${panel.module}-${panelIndex}`} panel={panel} state={state} />
        ))}
      </div>
    );
  }

  const panel = panels[index % panels.length];
  return (
    <div className={`display-region display-region-${region.key}`}>
      <Panel panel={panel} state={state} />
    </div>
  );
}

function ActiveScreen({
  payload,
  stale,
}: {
  payload: DisplayPayload;
  stale: boolean;
}) {
  const { template, ...state } = payload;
  const definition: DisplayTemplateDefinition = template;

  return (
    <div className="display-screen" data-template={definition.key}>
      {definition.regions.map((region) => (
        <Region key={region.key} region={region} state={state} />
      ))}
      {stale && <span className="display-stale-badge">Data may be out of date</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout engine (LTV-027, ADR-003 §1/§2): renders a v2 Layout+Template. The
// fixed shell (header + editable footer) stays out of the editable body; the
// body is `bodyHtml` split on {{area:key}} placeholders, HTML segments rendered
// verbatim (already server-sanitised) and each placeholder rendering its Area.
// ---------------------------------------------------------------------------

/** The neutral, never-crash placeholder — the same graceful-degrade stance as
 * the legacy Panel path: a broken/unknown slot leaves a quiet gap on the wall,
 * not an error. */
function NeutralPlaceholder({ module }: { module?: string }) {
  return <div className="display-module-placeholder" data-module={module} />;
}

/** Mount a module referenced by a `{{module:<name>}}` embed token in authored
 * html (LTV-028). Embed tokens carry no options in v1 (module options belong to
 * `{module, options}` slot content), so none are passed. An unknown module name
 * → the neutral placeholder, exactly like an unknown area — the same
 * graceful-degrade stance the rest of the engine takes. */
function ModuleMount({ name, state }: { name: string; state: DisplayState }) {
  const Module = DISPLAY_MODULE_COMPONENTS[name as DisplayModuleName];
  if (!Module) return <NeutralPlaceholder module={name} />;
  return <Module state={state} />;
}

/**
 * Fill a container with server-sanitised html and return the inert marker
 * elements to portal Area/module components into (LTV-041, issue #96).
 *
 * The html is written IMPERATIVELY (`root.innerHTML = html`), NOT via React's
 * `dangerouslySetInnerHTML`: React refuses to mount a portal into a DOM node it
 * wrote itself as innerHTML, but it mounts happily into DOM it does not manage.
 * The container is an empty `<div>` in JSX, so React never touches the children
 * we inject — and each `<div data-display-*>` marker becomes a valid portal
 * target. Runs client-only (useEffect), matching the page's force-dynamic,
 * blank-first-frame pattern, so markers resolve the frame after mount (never
 * during SSR). Re-runs when `html` changes (a payload refresh rewrites the
 * innerHTML), re-resolving markers against the fresh DOM nodes.
 */
function useMarkerPortals(
  containerRef: RefObject<HTMLDivElement | null>,
  markerAttr: string,
  html: string
): Array<{ key: string; element: Element }> {
  const [markers, setMarkers] = useState<Array<{ key: string; element: Element }>>([]);
  useEffect(() => {
    const root = containerRef.current;
    if (!root) {
      setMarkers([]);
      return;
    }
    root.innerHTML = html;
    setMarkers(
      Array.from(root.querySelectorAll(`[${markerAttr}]`)).map((element) => ({
        key: element.getAttribute(markerAttr) ?? "",
        element,
      }))
    );
  }, [containerRef, markerAttr, html]);
  return markers;
}

/** Render an authored html surface (already server-sanitised AND value-token
 * resolved at serve time, with `{{module:<name>}}` embeds swapped for inert
 * `<div data-display-module>` markers — layout-render.ts). The whole html is set
 * as ONE innerHTML block so nesting is preserved, then each module component is
 * portalled into its marker (LTV-041). A surface with no embed simply mounts no
 * portals — byte-for-byte the same DOM as a plain html slot/footer. */
function AuthoredHtml({
  html,
  state,
  className,
}: {
  html: string;
  state: DisplayState;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markers = useMarkerPortals(containerRef, DISPLAY_MODULE_MARKER_ATTR, html);
  return (
    <>
      <div ref={containerRef} className={className} />
      {markers.map(({ key, element }, index) =>
        createPortal(
          <ModuleMount name={key} state={state} />,
          element,
          `module-${key}-${index}`
        )
      )}
    </>
  );
}

/** Render one slot's content: authored HTML (already sanitised + token-resolved
 * server-side, and split here on any {{module:…}} embeds) or an embedded module.
 * An unknown module → the neutral placeholder. A missing slot (no content, no
 * default) → nothing. */
function SlotRender({
  content,
  state,
}: {
  content: SlotContent | undefined;
  state: DisplayState;
}) {
  if (!content) return null;
  if ("module" in content) {
    const Module = DISPLAY_MODULE_COMPONENTS[content.module];
    if (!Module) return <NeutralPlaceholder module={content.module} />;
    return <Module state={state} options={content.options} />;
  }
  return <AuthoredHtml html={content.html} state={state} />;
}

/** A rotator area: cycle only among children whose condition currently holds,
 * on the area's rotateSeconds timer — the same pattern as the legacy Region.
 * Zero eligible children renders nothing. */
function RotatorArea({
  area,
  slotContent,
  state,
}: {
  area: DisplayAreaDefinition;
  slotContent: LayoutRenderPayload["slotContent"];
  state: DisplayState;
}) {
  const eligible = (area.children ?? []).filter((child) =>
    evaluateDisplayCondition(child.condition ?? "always", state)
  );
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (eligible.length <= 1) return;
    const seconds = area.rotateSeconds ?? DEFAULT_ROTATE_SECONDS;
    const timer = setInterval(
      () => setIndex((current) => current + 1),
      seconds * 1000
    );
    return () => clearInterval(timer);
  }, [eligible.length, area.rotateSeconds]);

  if (eligible.length === 0) return null;
  const child = eligible[index % eligible.length];
  return (
    <SlotRender content={slotContent[`${area.key}/${child.key}`]} state={state} />
  );
}

/** One named area: static (always), conditional (only while its condition
 * holds), or rotator (cycles its eligible children). */
function Area({
  area,
  slotContent,
  state,
}: {
  area: DisplayAreaDefinition | undefined;
  slotContent: LayoutRenderPayload["slotContent"];
  state: DisplayState;
}) {
  // Server validation guarantees every placeholder has an area; stay defensive
  // for the unattended wall regardless.
  if (!area) return <NeutralPlaceholder />;
  if (area.kind === "rotator") {
    return <RotatorArea area={area} slotContent={slotContent} state={state} />;
  }
  if (area.kind === "conditional") {
    if (!evaluateDisplayCondition(area.condition ?? "always", state)) return null;
  }
  const content = slotContent[area.key] ?? area.defaultContent;
  return <SlotRender content={content} state={state} />;
}

/** Render boundary around each body segment: a throwing module/area drops to
 * the neutral placeholder instead of blanking the whole wall (LTV-030 hardens
 * this further). */
class AreaErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <NeutralPlaceholder />;
    return this.props.children;
  }
}

/**
 * The editable body: the whole (server-sanitised, value-resolved) bodyHtml set as
 * ONE innerHTML block, with each `<div data-display-area>` marker portalling its
 * Area (LTV-041, issue #96). Rendering the body whole — instead of splitting it
 * into sibling fragments — is what lets an area sit INSIDE an authored container
 * (`<div class="two-plus-one"><div class="main-col">{{area:main}}</div>…`): the
 * grid keeps its children, the areas mount inside them. Each Area stays wrapped
 * in its own error boundary so a throwing slot drops to the neutral placeholder,
 * never blanking the wall.
 */
function LayoutBody({
  bodyHtml,
  areasByKey,
  slotContent,
  state,
}: {
  bodyHtml: string;
  areasByKey: Map<string, DisplayAreaDefinition>;
  slotContent: LayoutRenderPayload["slotContent"];
  state: DisplayState;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markers = useMarkerPortals(containerRef, DISPLAY_AREA_MARKER_ATTR, bodyHtml);
  return (
    <>
      <div ref={containerRef} className="display-layout-body" />
      {markers.map(({ key, element }, index) =>
        createPortal(
          <AreaErrorBoundary>
            <Area area={areasByKey.get(key)} slotContent={slotContent} state={state} />
          </AreaErrorBoundary>,
          element,
          `area-${key}-${index}`
        )
      )}
    </>
  );
}

function LayoutScreen({
  payload,
  stale,
}: {
  payload: DisplayPayload & { layoutRender: LayoutRenderPayload };
  stale: boolean;
}) {
  // Strip layoutRender; the rest (incl. the legacy `template` fallback field)
  // is a superset of DisplayState and safe to pass to the shell/modules.
  const { layoutRender, ...state } = payload;
  const areasByKey = useMemo(
    () => new Map(layoutRender.areas.map((area) => [area.key, area])),
    [layoutRender.areas]
  );
  const authoredFooter = layoutRender.footerHtml;

  // Three ordered <style> tags — theme → layout → overrides (LTV-029, #75). The
  // club-theme variables are non-authored and unscoped (they define `--brand-*`
  // on :root); the layout default and template overrides are already sanitised
  // AND selector-scoped to `.display-authored-root` server-side, so they only
  // reach the editable body/footer, never the fixed header chrome.
  return (
    <div className="display-screen display-layout-screen">
      <style
        data-display-style="theme"
        dangerouslySetInnerHTML={{ __html: layoutRender.themeCss ?? "" }}
      />
      <style
        data-display-style="layout"
        dangerouslySetInnerHTML={{ __html: layoutRender.defaultCss }}
      />
      <style
        data-display-style="overrides"
        dangerouslySetInnerHTML={{ __html: layoutRender.cssOverrides }}
      />
      {/* Fixed header chrome lives OUTSIDE the authored root so authored CSS
          can never restyle the clock/brand. */}
      <LodgeHeader state={state} />
      {/* The authored root is a layout-invisible wrapper (display:contents) that
          anchors the scoped authored CSS to the editable body + authored footer. */}
      <div className={DISPLAY_AUTHORED_ROOT_CLASS}>
        <LayoutBody
          bodyHtml={layoutRender.bodyHtml}
          areasByKey={areasByKey}
          slotContent={layoutRender.slotContent}
          state={state}
        />
        {authoredFooter ? (
          <AuthoredHtml
            html={authoredFooter}
            state={state}
            className="display-info-footer"
          />
        ) : null}
      </div>
      {/* The built-in InfoFooter is page chrome — kept outside the authored
          root, exactly like the header. */}
      {authoredFooter ? null : <InfoFooter state={state} />}
      {stale && <span className="display-stale-badge">Data may be out of date</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page-level safe fallback (LTV-030, ADR-003 §5 "Unattended surface"): a WHOLE-
// LayoutScreen failure must never blank a wall. The everyday-board built-in is
// the deterministic known-good minimal board; rendering it through the proven
// legacy Region path (its own header/footer regions carry the fixed LodgeHeader
// and standard InfoFooter) means the fallback leans only on code that predates
// the authoring engine. Two triggers land here: a client-side LayoutScreen throw
// (caught by LayoutErrorBoundary) and a server-signalled broken binding
// (payload.layoutRenderError — the template row/layout is gone or failed
// serve-time validation, so no layoutRender shipped).
// ---------------------------------------------------------------------------

const FALLBACK_TEMPLATE: DisplayTemplateDefinition =
  listBuiltInDisplayTemplates().find(
    (template) => template.key === DEFAULT_DISPLAY_TEMPLATE_KEY
  ) ?? listBuiltInDisplayTemplates()[0];

function FallbackBoard({
  payload,
  stale,
}: {
  payload: DisplayPayload;
  stale: boolean;
}) {
  // DisplayPayload is a superset of DisplayState; the legacy modules read only
  // DisplayState keys, so passing the payload straight through is safe (and any
  // broken layoutRender field is simply never read by this path).
  const state = payload;
  // A real wall shows no error text; an admin previewing sees why the board
  // changed. Computed from the URL (client-only — this component only ever
  // renders after mount, downstream of an error/flag, so there is no SSR of it).
  const isPreview =
    typeof window !== "undefined" && readPreviewState().isPreview;
  return (
    <div
      className="display-screen display-fallback-board"
      data-template={FALLBACK_TEMPLATE.key}
      data-display-fallback=""
    >
      {FALLBACK_TEMPLATE.regions.map((region) => (
        <Region key={region.key} region={region} state={state} />
      ))}
      {isPreview && (
        <span className="display-fallback-marker">
          Template failed — showing fallback board
        </span>
      )}
      {stale && <span className="display-stale-badge">Data may be out of date</span>}
    </div>
  );
}

/** Page-level render boundary around the whole layout screen: any throw inside
 * LayoutScreen (a malformed payload that slipped past serve-time validation, a
 * module crashing outside an AreaErrorBoundary, …) drops the ENTIRE board to the
 * known-good FallbackBoard rather than blanking the wall. Like AreaErrorBoundary
 * it does not auto-reset — a persistently broken payload stays on the fallback
 * until the page reloads, which is the safe stance for an unattended screen. */
class LayoutErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

/** The last-resort board (issue #176, ADR-003 §5 "Unattended surface"): the
 * fallback when even the FallbackBoard or the legacy ActiveScreen throws. It has
 * ZERO data dependencies — no payload, no template, no modules — so it can never
 * itself throw, and it keeps the wall on the branded dark shell rather than a
 * blank page (the route-segment `error.tsx` renders the same quiet shell for a
 * throw that escapes the React tree entirely). Silent on a real wall by design:
 * an unattended screen shows no error text, just an intentionally-on background. */
function MinimalDisplayShell() {
  // The boundary renders this IN PLACE of the display-shell subtree, so no
  // ancestor supplies positioning or background — inline both, exactly like
  // the route-segment error.tsx, so the quiet shell holds even without the
  // `.display-shell` ancestor and even if the route stylesheet has not applied.
  return (
    <div
      className="display-shell display-loading"
      data-display-fallback="minimal"
      style={{
        position: "fixed",
        inset: 0,
        background:
          "linear-gradient(160deg, #08171d 0%, #0a1c23 55%, #07141a 100%)",
      }}
    />
  );
}

export function DisplayScreen() {
  const lifecycle = useDisplayState();

  if (lifecycle.mode === "loading") {
    return <div className="display-shell display-loading" />;
  }

  if (lifecycle.mode === "preview-denied") {
    return (
      <div className="display-shell display-pairing">
        <span className="display-pairing-kicker">Display preview</span>
        <span className="display-pairing-help">
          Previewing the lobby display requires an administrator login in this
          browser. Sign in to the admin area, then reload this page.
        </span>
      </div>
    );
  }

  if (lifecycle.mode === "pairing") {
    return (
      <div className="display-shell display-pairing">
        <span className="display-pairing-kicker">Pair this display</span>
        {lifecycle.code ? (
          <>
            <span className="display-pairing-code">{lifecycle.code}</span>
            <span className="display-pairing-help">
              An administrator enters this code against a display device in the
              lodge admin area. It expires after 15 minutes; a fresh code
              appears automatically.
            </span>
          </>
        ) : (
          <span className="display-pairing-help">Requesting a pairing code…</span>
        )}
      </div>
    );
  }

  // A v2 layout render wins when present (device bound to a Layout+Template),
  // wrapped in the page-level boundary so a render-time throw drops to the
  // known-good FallbackBoard (LTV-030). A broken binding the server already
  // caught (layoutRenderError, no layoutRender) renders the same FallbackBoard
  // directly — silent on a real wall, marked in preview. Otherwise the legacy
  // built-in board path renders the club-default board: LTV-038 seeded the three
  // built-ins as v2 rows (devices now bind them by templateId → LayoutScreen), so
  // this ActiveScreen path serves only a device with NO binding, plus it and the
  // Region renderer remain the zero-DB engine the FallbackBoard leans on.
  // Unattended-safety contract (issue #176, ADR-003 §5): a throwing module/board
  // must NEVER blank the wall, so EVERY render branch is wrapped. The authored
  // branch degrades to the known-good FallbackBoard (its own boundary, as
  // before). The legacy ActiveScreen and the already-degraded FallbackBoard
  // branch — and a FallbackBoard that itself throws — drop to the minimal,
  // zero-data shell via the OUTER boundary. `error.tsx` is the framework-level
  // backstop beyond even this, for a throw that escapes the React tree.
  const { payload, stale } = lifecycle;
  let board: ReactNode;
  if (payload.layoutRender) {
    board = (
      <LayoutErrorBoundary fallback={<FallbackBoard payload={payload} stale={stale} />}>
        <LayoutScreen
          payload={{ ...payload, layoutRender: payload.layoutRender }}
          stale={stale}
        />
      </LayoutErrorBoundary>
    );
  } else if (payload.layoutRenderError) {
    board = <FallbackBoard payload={payload} stale={stale} />;
  } else {
    board = <ActiveScreen payload={payload} stale={stale} />;
  }
  return (
    <LayoutErrorBoundary fallback={<MinimalDisplayShell />}>
      <div className="display-shell">{board}</div>
    </LayoutErrorBoundary>
  );
}
