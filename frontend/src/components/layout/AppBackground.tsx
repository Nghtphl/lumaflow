/**
 * The page ground: one soft vertical lift at the top and nothing else.
 *
 * There is no grid, no texture and no light source. A ruled backdrop turns
 * every card into a floating panel on a drafting table, which is exactly the
 * "workspace" look this interface should not have — the content is the only
 * thing on the page with structure.
 */
export function AppBackground() {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[32rem]"
      aria-hidden="true"
      style={{
        backgroundImage:
          "linear-gradient(to bottom, color-mix(in srgb, var(--color-surface) 70%, var(--color-canvas)) 0%, var(--color-canvas) 100%)",
      }}
    />
  );
}
