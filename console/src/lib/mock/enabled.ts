// The mock switch. A public variable injected at build time (only a NEXT_PUBLIC_ prefix is readable in the browser).
// Setting NEXT_PUBLIC_MOCK=1 on Vercel makes the whole site run on mocks with no backend.
export const MOCK = process.env.NEXT_PUBLIC_MOCK === "1";
