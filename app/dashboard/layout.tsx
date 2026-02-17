import { TeamFilterProvider } from "@/hooks/use-team-filter";

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <TeamFilterProvider>{children}</TeamFilterProvider>;
}
