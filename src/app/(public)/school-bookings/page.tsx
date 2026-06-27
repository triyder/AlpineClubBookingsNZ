"use client";

import type { AgeTier } from "@prisma/client";
import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useAgeTierOptions } from "@/lib/use-age-tier-options";

// Schools request counts of children per age tier; teachers are named adults.
const CHILD_TIERS: AgeTier[] = ["INFANT", "CHILD", "YOUTH"];

interface TeacherInput {
  firstName: string;
  lastName: string;
  email: string;
}

function emptyTeacher(): TeacherInput {
  return { firstName: "", lastName: "", email: "" };
}

function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function SchoolBookingRequestPage() {
  const club = useClubIdentity();
  const ageTierOptions = useAgeTierOptions();
  const [schoolName, setSchoolName] = useState("");
  const [contactFirstName, setContactFirstName] = useState("");
  const [contactLastName, setContactLastName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [message, setMessage] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [cateringPreference, setCateringPreference] = useState<
    "CATERED" | "NON_CATERED" | "QUOTE_BOTH"
  >("QUOTE_BOTH");
  const [teachers, setTeachers] = useState<TeacherInput[]>([emptyTeacher()]);
  const [childCounts, setChildCounts] = useState<Record<string, number>>({
    INFANT: 0,
    CHILD: 0,
    YOUTH: 0,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const childTierLabel = (tier: AgeTier) =>
    ageTierOptions.find((option) => option.tier === tier)?.label ?? tier;

  const totalChildren = CHILD_TIERS.reduce((sum, tier) => sum + (childCounts[tier] || 0), 0);
  const validTeachers = teachers.filter((t) => t.firstName.trim() && t.lastName.trim());
  const totalGuests = validTeachers.length + totalChildren;
  const datesValid = Boolean(checkIn && checkOut && checkOut > checkIn);

  function updateTeacher(index: number, field: keyof TeacherInput, value: string) {
    setTeachers((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: value } : t)));
  }

  function addTeacher() {
    setTeachers((prev) => [...prev, emptyTeacher()]);
  }

  function removeTeacher(index: number) {
    setTeachers((prev) => prev.filter((_, i) => i !== index));
  }

  function updateChildCount(tier: AgeTier, value: string) {
    const parsed = Math.max(0, Math.floor(Number(value) || 0));
    setChildCounts((prev) => ({ ...prev, [tier]: parsed }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!schoolName.trim()) {
      setError("Please enter the school name.");
      return;
    }
    if (!datesValid) {
      setError("Check-out must be after check-in.");
      return;
    }
    if (validTeachers.length === 0) {
      setError("Please add at least one teacher with a name.");
      return;
    }
    if (totalChildren === 0) {
      setError("Please enter the number of children attending.");
      return;
    }
    if (totalGuests > club.lodgeCapacity) {
      setError(`Total guests (${totalGuests}) exceeds the lodge capacity of ${club.lodgeCapacity}.`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/booking-requests/school", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schoolName,
          contactFirstName,
          contactLastName,
          contactEmail,
          contactPhone: contactPhone || undefined,
          checkIn,
          checkOut,
          cateringPreference,
          teachers: validTeachers.map((t) => ({
            firstName: t.firstName,
            lastName: t.lastName,
            email: t.email.trim() || undefined,
          })),
          childCounts: {
            INFANT: childCounts.INFANT || undefined,
            CHILD: childCounts.CHILD || undefined,
            YOUTH: childCounts.YOUTH || undefined,
          },
          message: message || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to submit your school booking request right now.");
      }
      setSubmitted(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to submit your school booking request right now."
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Request Sent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-6 w-6 shrink-0" />
            <p className="font-medium">Thanks, {contactFirstName} — almost there.</p>
          </div>
          <p className="text-sm text-muted-foreground">
            We&apos;ve sent a confirmation email to {contactEmail}. Please click the link inside to
            confirm your email address. Once confirmed, your request will join our review queue and
            {" "}{club.lodgeName} will send a quote for your school to review.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>School Group Booking Request</CardTitle>
        <CardDescription>
          Request a school group stay at {club.lodgeName}. We&apos;ll email you to confirm your
          address, then send a quote for your school to review.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {error ? (
            <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="schoolName">School name</Label>
            <Input
              id="schoolName"
              value={schoolName}
              onChange={(e) => setSchoolName(e.target.value)}
              required
              maxLength={200}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="contactFirstName">Contact first name</Label>
              <Input
                id="contactFirstName"
                value={contactFirstName}
                onChange={(e) => setContactFirstName(e.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactLastName">Contact last name</Label>
              <Input
                id="contactLastName"
                value={contactLastName}
                onChange={(e) => setContactLastName(e.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactEmail">Contact email (school invoice)</Label>
              <Input
                id="contactEmail"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                required
                maxLength={200}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactPhone">Phone (optional)</Label>
              <Input
                id="contactPhone"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                maxLength={30}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="checkIn">Check-in</Label>
              <Input
                id="checkIn"
                type="date"
                value={checkIn}
                min={todayDateOnly()}
                onChange={(e) => setCheckIn(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="checkOut">Check-out</Label>
              <Input
                id="checkOut"
                type="date"
                value={checkOut}
                min={checkIn || todayDateOnly()}
                onChange={(e) => setCheckOut(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="cateringPreference">Catering</Label>
            <Select
              value={cateringPreference}
              onValueChange={(value) =>
                setCateringPreference(value as "CATERED" | "NON_CATERED" | "QUOTE_BOTH")
              }
            >
              <SelectTrigger id="cateringPreference">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="QUOTE_BOTH">Quote catered and non-catered</SelectItem>
                <SelectItem value="CATERED">Catered</SelectItem>
                <SelectItem value="NON_CATERED">Non-catered</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Teachers attending (hut leaders)</h3>
              <Button type="button" variant="outline" size="sm" onClick={addTeacher}>
                + Add Teacher
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Each teacher is set up as a hut leader and emailed their kiosk PIN. If no email is
              given, the PIN goes to the contact email above.
            </p>

            {teachers.map((teacher, index) => (
              <div key={index} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <div className="space-y-1">
                  <Label>First name</Label>
                  <Input
                    value={teacher.firstName}
                    onChange={(e) => updateTeacher(index, "firstName", e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Last name</Label>
                  <Input
                    value={teacher.lastName}
                    onChange={(e) => updateTeacher(index, "lastName", e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Email (optional)</Label>
                  <Input
                    type="email"
                    value={teacher.email}
                    onChange={(e) => updateTeacher(index, "email", e.target.value)}
                    maxLength={200}
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeTeacher(index)}
                    disabled={teachers.length <= 1}
                    className="text-red-500 hover:text-red-700"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Children attending</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              {CHILD_TIERS.map((tier) => (
                <div key={tier} className="space-y-1">
                  <Label htmlFor={`count-${tier}`}>{childTierLabel(tier)}</Label>
                  <Input
                    id={`count-${tier}`}
                    type="number"
                    min="0"
                    value={childCounts[tier] || 0}
                    onChange={(e) => updateChildCount(tier, e.target.value)}
                  />
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              Total guests: {totalGuests} / {club.lodgeCapacity} max ({validTeachers.length} teachers,
              {" "}{totalChildren} children)
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="message">Message (optional)</Label>
            <Textarea
              id="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={1000}
              placeholder="Anything else we should know about your visit?"
            />
          </div>

          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? "Submitting..." : "Submit school request"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
