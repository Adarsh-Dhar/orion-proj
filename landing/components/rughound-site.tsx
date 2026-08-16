'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ArrowRight, Check, ChevronDown, CircleAlert, CircleCheck, Play, ShieldCheck, Sparkles, X } from 'lucide-react'

const navItems = [
  { label: 'Product', href: '#product' },
  { label: 'How it works', href: '#how-it-works' },
  { label: 'FAQ', href: '#faq' },
]

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-3" aria-label="Rughound home">
      <span className="relative flex size-10 items-center justify-center overflow-hidden rounded-xl bg-primary">
        <img src="/rughound-purple.png" alt="" className="size-9 scale-[1.7] object-cover object-top" />
      </span>
      {!compact && <span className="font-mono text-lg font-bold tracking-[0.16em] text-primary">RUGHOUND</span>}
    </Link>
  )
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/80 bg-background/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 lg:px-8">
        <Logo />
        <nav className="hidden items-center gap-7 md:flex" aria-label="Main navigation">
          {navItems.map((item) => <a key={item.href} href={item.href} className="text-sm font-medium text-muted-foreground transition-colors hover:text-primary">{item.label}</a>)}
        </nav>
        <a href="https://web.telegram.org/a/#8992459816" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-transform hover:-translate-y-0.5">Try Rughound <ArrowRight className="size-4" /></a>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-primary py-10 text-primary-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 lg:px-8 md:flex-row md:items-center md:justify-between">
        <div><Logo /><p className="mt-3 max-w-xs text-sm text-primary-foreground/65">Your first line of defense against crypto rugs.</p></div>
        <div className="flex gap-5 text-sm text-primary-foreground/70"><Link href="/privacy" className="hover:text-primary-foreground">Privacy</Link><Link href="/terms" className="hover:text-primary-foreground">Terms</Link><a href="mailto:hello@rughound.xyz" className="hover:text-primary-foreground">Contact</a></div>
      </div>
    </footer>
  )
}

export function MediaPlaceholder({ type }: { type: 'screenshot' | 'video' }) {
  const isVideo = type === 'video'
  return <div className={`media-placeholder ${isVideo ? 'aspect-video' : 'aspect-[16/10]'}`}>
    <div className="flex flex-col items-center gap-3 text-center"><span className="flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">{isVideo ? <Play className="ml-1 size-6 fill-current" /> : <Sparkles className="size-6" />}</span><div><p className="font-mono text-sm font-bold uppercase tracking-[0.16em] text-primary">{isVideo ? 'Product video' : 'Product screenshot'}</p><p className="mt-1 text-sm text-muted-foreground">Media goes here</p></div></div>
  </div>
}

export function RughoundLanding() {
  const [openFaq, setOpenFaq] = useState<number | null>(0)
  const faqs = [
    ['What is Rughound?', 'Rughound is a fast, clear token risk scanner that helps you understand suspicious contract behavior before you buy.'],
    ['Does Rughound hold my funds?', 'No. Rughound is an analysis tool only. It never asks for custody, seed phrases, or wallet permissions.'],
    ['Which chains are supported?', 'The first release focuses on EVM tokens, with more networks planned as the product grows.'],
  ]
  return <div className="min-h-screen bg-background text-foreground"><SiteHeader /><main>
    <section className="relative overflow-hidden bg-primary px-5 py-20 text-primary-foreground lg:px-8 lg:py-28"><div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_.95fr]"><div><div className="mb-7 inline-flex items-center gap-2 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground/80"><ShieldCheck className="size-4" /> Built for safer decisions</div><h1 className="max-w-3xl font-serif text-5xl leading-[0.98] tracking-tight text-balance sm:text-6xl lg:text-7xl">Don&apos;t get rugged.<br /><span className="text-brand-tan">Get Rughound.</span></h1><p className="mt-7 max-w-xl text-lg leading-8 text-primary-foreground/72">Scan any token contract and spot the red flags before they cost you. Clear signals, no crypto jargon, no guesswork.</p><div className="mt-9 flex flex-wrap gap-3"><Link href="/demo" className="inline-flex items-center gap-2 rounded-full bg-brand-tan px-5 py-3 font-semibold text-primary transition-transform hover:-translate-y-0.5">Scan a token <ArrowRight className="size-4" /></Link><a href="#how-it-works" className="inline-flex items-center rounded-full border border-primary-foreground/25 px-5 py-3 font-semibold text-primary-foreground hover:bg-primary-foreground/10">See how it works</a></div></div><div className="relative flex justify-center"><div className="absolute inset-12 rounded-full bg-brand-tan/15 blur-3xl" /><img src="/rughound-purple.png" alt="Rughound dog mascot and wordmark" className="relative w-full max-w-md object-contain" style={{ maskImage: 'radial-gradient(ellipse at center, black 58%, transparent 82%)', WebkitMaskImage: 'radial-gradient(ellipse at center, black 58%, transparent 82%)' }} /></div></div></section>
    <section className="border-b border-border bg-brand-cream px-5 py-5 lg:px-8"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm font-semibold text-primary sm:justify-between"><span className="flex items-center gap-2"><CircleCheck className="size-4 text-brand-green" /> Instant contract scan</span><span className="flex items-center gap-2"><CircleCheck className="size-4 text-brand-green" /> Plain-English verdicts</span><span className="flex items-center gap-2"><CircleCheck className="size-4 text-brand-green" /> No wallet connection</span></div></section>
    <section id="product" className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28"><div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr] lg:items-center"><div><p className="eyebrow">Your contract watchdog</p><h2 className="section-title">A second set of eyes before you ape in.</h2><p className="mt-5 text-lg leading-8 text-muted-foreground">Paste a token address. Rughound checks the contract patterns rug pullers rely on, then gives you a verdict you can actually understand.</p><div className="mt-8 space-y-4"><Feature icon={<CircleAlert />} title="Catch the warning signs" text="Ownership, liquidity, taxes, minting, and blacklist risks in one scan." /><Feature icon={<ShieldCheck />} title="Know before you buy" text="A fast risk summary keeps your next move informed, not emotional." /></div></div><MediaPlaceholder type="screenshot" /></div></section>
    <section id="how-it-works" className="bg-brand-cream px-5 py-20 lg:px-8 lg:py-28"><div className="mx-auto max-w-6xl"><div className="max-w-2xl"><p className="eyebrow">How it works</p><h2 className="section-title">Three steps between you and a bad buy.</h2></div><div className="mt-12 grid gap-4 md:grid-cols-3"><Step n="01" title="Paste the address" text="Drop in a token contract address from your favorite chain." /><Step n="02" title="Let the hound sniff" text="Rughound checks the contract for common rug-pull mechanics." /><Step n="03" title="Read your verdict" text="Get a clean, color-coded risk report before you trade." /></div></div></section>
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28"><div className="grid gap-12 lg:grid-cols-2 lg:items-center"><div><p className="eyebrow">See it in action</p><h2 className="section-title">No theater. Just a useful answer.</h2><p className="mt-5 text-lg leading-8 text-muted-foreground">Watch Rughound go from contract address to risk verdict in seconds. Leave room for your product walkthrough here.</p><Link href="/demo" className="mt-8 inline-flex items-center gap-2 font-semibold text-primary hover:gap-3">Open interactive demo <ArrowRight className="size-4" /></Link></div><MediaPlaceholder type="video" /></div></section>
    <section id="faq" className="bg-primary px-5 py-20 text-primary-foreground lg:px-8 lg:py-24"><div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[.75fr_1.25fr]"><div><p className="eyebrow text-brand-tan">Questions, answered</p><h2 className="section-title text-primary-foreground">Keep your wallet. Lose the guesswork.</h2></div><div className="space-y-2">{faqs.map(([q, a], i) => <div key={q} className="border-b border-primary-foreground/15"><button onClick={() => setOpenFaq(openFaq === i ? null : i)} className="flex w-full items-center justify-between py-5 text-left font-semibold"><span>{q}</span><ChevronDown className={`size-5 transition-transform ${openFaq === i ? 'rotate-180' : ''}`} /></button>{openFaq === i && <p className="pb-5 leading-7 text-primary-foreground/65">{a}</p>}</div>)}</div></div></section>
    <section className="bg-brand-tan px-5 py-16 lg:px-8"><div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-7 md:flex-row md:items-center"><div><p className="font-mono text-xs font-bold uppercase tracking-[0.16em] text-primary/65">Ready when you are</p><h2 className="mt-2 font-serif text-4xl tracking-tight text-primary">Trust your next trade to the hound.</h2></div><Link href="/demo" className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 font-semibold text-primary-foreground hover:opacity-90">Try Rughound <ArrowRight className="size-4" /></Link></div></section>
  </main><SiteFooter /></div>
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="flex gap-4"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-cream text-primary [&_svg]:size-5">{icon}</span><div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{text}</p></div></div> }
function Step({ n, title, text }: { n: string; title: string; text: string }) { return <div className="rounded-2xl border border-border bg-background p-6"><span className="font-mono text-sm font-bold text-primary">{n}</span><h3 className="mt-8 text-xl font-semibold text-primary">{title}</h3><p className="mt-3 leading-7 text-muted-foreground">{text}</p></div> }

export function DemoPage() { return <div className="min-h-screen bg-background"><SiteHeader /><main className="mx-auto max-w-6xl px-5 py-16 lg:px-8 lg:py-24"><p className="eyebrow">Interactive preview</p><h1 className="section-title max-w-2xl">Let Rughound take a look.</h1><p className="mt-5 max-w-xl text-lg leading-8 text-muted-foreground">This is the space for the working scanner experience. Connect your token lookup here when the product is ready.</p><div className="mt-12 rounded-3xl border border-border bg-brand-cream p-5 sm:p-8"><div className="flex flex-col gap-3 sm:flex-row"><input aria-label="Token contract address" placeholder="Paste a token contract address" className="min-h-12 flex-1 rounded-xl border border-border bg-background px-4 outline-none ring-primary focus:ring-2" /><button className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary px-5 font-semibold text-primary-foreground">Scan contract <ArrowRight className="size-4" /></button></div><div className="mt-8 grid gap-4 md:grid-cols-3"><Verdict icon={<CircleCheck />} label="Contract status" value="Awaiting scan" /><Verdict icon={<ShieldCheck />} label="Liquidity" value="Not checked" /><Verdict icon={<X />} label="Risk verdict" value="No verdict yet" /></div></div></main><SiteFooter /></div> }
function Verdict({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div className="rounded-2xl border border-border bg-background p-5"><span className="flex size-9 items-center justify-center rounded-lg bg-brand-cream text-primary [&_svg]:size-4">{icon}</span><p className="mt-6 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 font-semibold text-primary">{value}</p></div> }

export function LegalPage({ type }: { type: 'privacy' | 'terms' }) { const isPrivacy = type === 'privacy'; return <div className="min-h-screen bg-background"><SiteHeader /><main className="mx-auto max-w-3xl px-5 py-16 lg:px-8 lg:py-24"><p className="eyebrow">Rughound</p><h1 className="section-title">{isPrivacy ? 'Privacy policy' : 'Terms of use'}</h1><p className="mt-5 text-muted-foreground">Last updated August 17, 2026</p><div className="prose-rughound mt-12 space-y-8"><p>{isPrivacy ? 'Rughound is designed to help you research token contracts. We collect only the information needed to operate the service, improve reliability, and respond to support requests.' : 'By using Rughound, you agree to use the service responsibly and understand that its risk assessments are informational, not financial advice.'}</p><h2>{isPrivacy ? 'What we collect' : 'Using the service'}</h2><p>{isPrivacy ? 'Contract addresses submitted for scanning may be processed to produce a report. We do not ask for seed phrases, private keys, or wallet custody.' : 'Do not use Rughound to make decisions you do not understand. You are responsible for verifying contract data and accepting the risks of digital assets.'}</p><h2>{isPrivacy ? 'Questions' : 'Disclaimer'}</h2><p>{isPrivacy ? 'For privacy questions, contact hello@rughound.xyz.' : 'Rughound does not guarantee token safety, profitability, or uninterrupted availability. Nothing on this site is investment advice.'}</p></div></main><SiteFooter /></div> }

export { Check }
