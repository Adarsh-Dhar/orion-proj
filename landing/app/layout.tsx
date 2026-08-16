import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { DM_Serif_Display, Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })
const dmSerif = DM_Serif_Display({ subsets: ['latin'], weight: '400', variable: '--font-dm-serif' })

export const metadata: Metadata = {
  title: { default: 'Rughound — Don\'t get rugged.', template: '%s | Rughound' },
  description: 'Scan crypto token contracts and spot the red flags before they cost you.',
  generator: 'v0.app',
  icons: { icon: '/rughound-logo.png' },
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#2d5fa8',
  userScalable: true,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="bg-background"><body className={`${geist.variable} ${geistMono.variable} ${dmSerif.variable} antialiased`}>{children}{process.env.NODE_ENV === 'production' && <Analytics />}</body></html>
}
