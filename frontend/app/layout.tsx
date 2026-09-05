import type { Metadata } from 'next';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Agentic Kanban - Autonomous Task Board',
  description:
    'Planner and worker agents decompose an objective into work items, claim them independently and carry them to completion, with a person in control of the board throughout.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
