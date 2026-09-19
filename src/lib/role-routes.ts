/** Where each role lands after sign-in. Single source of truth so auth
 * actions and any nav/redirect logic never drift apart. */
export function roleHomePath(role: string): string {
  switch (role) {
    case "government":
      return "/government";
    case "department_incharge":
      return "/department";
    case "admin":
      return "/admin";
    case "citizen":
    default:
      return "/dashboard";
  }
}
