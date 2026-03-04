"use client"

import * as React from "react"
import { useSession } from "next-auth/react"
import { IconDownload } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface CostAllocationResult {
  month: string
  team: { id: number; name: string } | null
  members: Array<{
    userId: string | null
    name: string
    repos: Array<{ repositoryId: number; name: string; commits: number }>
    totalCommits: number
  }>
  repoTotals: Array<{
    repositoryId: number
    name: string
    commits: number
    percentage: number
  }>
  totalCommits: number
}

interface Team {
  id: number
  name: string
}

function getCurrentMonth(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  return `${year}-${month}`
}

function getRepoColumns(data: CostAllocationResult) {
  return data.repoTotals.map((r) => ({
    repositoryId: r.repositoryId,
    name: r.name,
  }))
}

function getCommitCount(
  member: CostAllocationResult["members"][number],
  repositoryId: number
): number {
  const repo = member.repos.find((r) => r.repositoryId === repositoryId)
  return repo?.commits ?? 0
}

function buildCsvContent(
  data: CostAllocationResult,
  teamCost: number | undefined
): string {
  const repos = getRepoColumns(data)
  const headers = ["Developer", ...repos.map((r) => r.name), "Total"]
  const rows: string[][] = []

  for (const member of data.members) {
    const row = [
      member.name,
      ...repos.map((r) => String(getCommitCount(member, r.repositoryId))),
      String(member.totalCommits),
    ]
    rows.push(row)
  }

  // Totals row
  const totalsRow = [
    "Total",
    ...data.repoTotals.map(
      (r) => `${r.commits} (${r.percentage.toFixed(1)}%)`
    ),
    String(data.totalCommits),
  ]
  rows.push(totalsRow)

  // Cost row
  if (teamCost !== undefined && teamCost > 0) {
    const costRow = [
      "Cost",
      ...data.repoTotals.map(
        (r) => `$${((r.percentage / 100) * teamCost).toFixed(2)}`
      ),
      `$${teamCost.toFixed(2)}`,
    ]
    rows.push(costRow)
  }

  const escape = (val: string) => {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`
    }
    return val
  }

  const csvLines = [headers.map(escape).join(",")]
  for (const row of rows) {
    csvLines.push(row.map(escape).join(","))
  }
  return csvLines.join("\n")
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-9 w-48" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

export function CostAllocationTable() {
  const { data: session } = useSession()
  const [month, setMonth] = React.useState(getCurrentMonth)
  const [teamId, setTeamId] = React.useState<number | undefined>(undefined)
  const [teamCost, setTeamCost] = React.useState<number | undefined>(undefined)
  const [data, setData] = React.useState<CostAllocationResult | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [teams, setTeams] = React.useState<Team[]>([])

  // Load teams from session organizations
  React.useEffect(() => {
    if (!session?.organizations) return
    const orgTeams: Team[] = []
    async function fetchTeams() {
      if (!session?.organizations) return
      for (const org of session.organizations) {
        try {
          const res = await fetch(
            `/api/organizations/${org.id}/teams`
          )
          if (res.ok) {
            const data = await res.json()
            for (const team of data) {
              if (
                team.id !== undefined &&
                team.name !== undefined &&
                !orgTeams.some((t) => t.id === team.id)
              ) {
                orgTeams.push({ id: team.id, name: team.name })
              }
            }
          }
        } catch {
          // Silently ignore team loading errors
        }
      }
      setTeams(orgTeams)
    }
    fetchTeams()
  }, [session?.organizations])

  // Fetch cost allocation data
  React.useEffect(() => {
    let cancelled = false
    async function fetchData() {
      setLoading(true)
      try {
        const params = new URLSearchParams({ month })
        if (teamId !== undefined) {
          params.set("teamId", String(teamId))
        }
        const res = await fetch(
          `/api/analytics/cost-allocation?${params.toString()}`
        )
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const result: CostAllocationResult = await res.json()
        if (!cancelled) {
          setData(result)
        }
      } catch (error) {
        console.error("Failed to fetch cost allocation data:", error)
        if (!cancelled) {
          setData(null)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    fetchData()
    return () => {
      cancelled = true
    }
  }, [month, teamId])

  const handleExportCsv = () => {
    if (!data) return
    const csv = buildCsvContent(data, teamCost)
    const filename = `cost-allocation-${data.month}${data.team ? `-${data.team.name}` : ""}.csv`
    downloadCsv(filename, csv)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost Allocation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Controls row */}
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="cost-month">Month</Label>
            <Input
              id="cost-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-40"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cost-team">Team</Label>
            <Select
              value={teamId !== undefined ? String(teamId) : "all"}
              onValueChange={(val) =>
                setTeamId(val === "all" ? undefined : parseInt(val, 10))
              }
            >
              <SelectTrigger id="cost-team" className="w-48">
                <SelectValue placeholder="All Teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Teams</SelectItem>
                {teams.map((team) => (
                  <SelectItem key={team.id} value={String(team.id)}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cost-amount">Monthly Team Cost</Label>
            <Input
              id="cost-amount"
              type="number"
              min={0}
              step={0.01}
              placeholder="Monthly team cost..."
              value={teamCost ?? ""}
              onChange={(e) => {
                const val = e.target.value
                setTeamCost(val === "" ? undefined : parseFloat(val))
              }}
              className="w-48"
            />
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={!data || data.members.length === 0}
          >
            <IconDownload className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>

        {/* Table */}
        {loading ? (
          <LoadingSkeleton />
        ) : !data || data.members.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center text-sm">
            No commit data found for {month}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Developer</TableHead>
                  {getRepoColumns(data).map((repo) => (
                    <TableHead key={repo.repositoryId} className="text-right">
                      {repo.name}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.members.map((member) => (
                  <TableRow key={member.userId ?? member.name}>
                    <TableCell className="font-medium">
                      {member.name}
                    </TableCell>
                    {getRepoColumns(data).map((repo) => (
                      <TableCell
                        key={repo.repositoryId}
                        className="text-right"
                      >
                        {getCommitCount(member, repo.repositoryId)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-medium">
                      {member.totalCommits}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                {/* Totals row */}
                <TableRow>
                  <TableCell className="font-medium">Total</TableCell>
                  {data.repoTotals.map((repo) => (
                    <TableCell
                      key={repo.repositoryId}
                      className="text-right"
                    >
                      {repo.commits}{" "}
                      <span className="text-muted-foreground text-xs">
                        ({repo.percentage.toFixed(1)}%)
                      </span>
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-medium">
                    {data.totalCommits}
                  </TableCell>
                </TableRow>

                {/* Cost allocation row */}
                {teamCost !== undefined && teamCost > 0 && (
                  <TableRow>
                    <TableCell className="font-medium">Cost</TableCell>
                    {data.repoTotals.map((repo) => (
                      <TableCell
                        key={repo.repositoryId}
                        className="text-right"
                      >
                        ${((repo.percentage / 100) * teamCost).toFixed(2)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-medium">
                      ${teamCost.toFixed(2)}
                    </TableCell>
                  </TableRow>
                )}
              </TableFooter>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
