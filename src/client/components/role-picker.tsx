import { vi } from "@/i18n/vi";
import { TENANT_ROLES, type Role, type TenantRole } from "@/shared/enums";

/** Checkbox group for tenant roles. Only a GA Head may hand out the GA Head role. */
export function RolePicker({ value, onChange, canGrantHead }: { value: Role[]; onChange: (roles: Role[]) => void; canGrantHead: boolean }) {
  const toggle = (role: TenantRole) =>
    onChange(value.includes(role) ? value.filter((r) => r !== role) : [...value, role]);
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{vi.users.roles}</legend>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {TENANT_ROLES.map((role) => (
          <label key={role} className="flex min-h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--brand-blue-100)]"
              checked={value.includes(role)}
              disabled={role === "GA_HEAD" && !canGrantHead}
              onChange={() => toggle(role)}
            />
            {vi.roles[role]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
