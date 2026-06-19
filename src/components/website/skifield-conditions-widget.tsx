import Script from "next/script";

const SNZ_WIDGET_SCRIPT_URL =
  "https://snowhq.com/widget-embeds/client/dist/widget.min.js";

export function SkifieldConditionsWidget({ dataHash }: { dataHash?: string }) {
  const hash = dataHash?.trim().toLowerCase();

  if (!hash || !/^[a-f0-9]{32}$/.test(hash)) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <strong>Ski field conditions widget:</strong> a 32-character hex hash is
        required. Use{" "}
        <code className="font-mono">
          {"{{skifield-conditions:your-hash-here}}"}
        </code>
      </div>
    );
  }

  return (
    <>
      <div className="js-snz-widget" data-hash={hash} />
      <Script
        id="snz-widget-loader"
        src={SNZ_WIDGET_SCRIPT_URL}
        strategy="afterInteractive"
      />
    </>
  );
}
