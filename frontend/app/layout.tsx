import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { DM_Serif_Display, Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })
const dmSerif = DM_Serif_Display({ subsets: ['latin'], weight: '400', variable: '--font-dm-serif' })

export const metadata: Metadata = {
  title: { default: 'Rughound — Don\'t get rugged.', template: '%s | Rughound' },
  description:
    'Orion reads every new Uniswap V3 and V4 pool on Base the moment it\'s created, pulls on-chain evidence, and posts a risk verdict before the pool has its first real trade.',
  icons: { icon: '/rughound-logo.png' },
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#322e70',
  userScalable: true,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-background">
      <body className={`${geist.variable} ${geistMono.variable} ${dmSerif.variable} antialiased min-h-full flex flex-col`}>
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
