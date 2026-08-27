import Link from "next/link";
import type { ReactNode } from "react";
import { LogoutButton } from "@/components/app/LogoutButton";
import {
  DEFAULT_ACCOUNT_DISPLAY_NAME,
  DEFAULT_ACCOUNT_USERNAME,
} from "@/lib/account-defaults";
import {
  BookOpenText,
  Clock3,
  FolderPlus,
  Folders,
  Guitar,
  House,
  LayoutGrid,
  List,
  Music2,
  Plus,
  Settings2,
  Star,
  Trash2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { MobileNavigationMenu } from "./MobileNavigationMenu";
import { TopBarSearch } from "./TopBarSearch";
import styles from "./AppShell.module.css";

export type SidebarIconName =
  | "home"
  | "albums"
  | "recent"
  | "favorites"
  | "trash"
  | "practice"
  | "manual"
  | "settings";

export type SidebarItem = {
  id: string;
  label: string;
  href: string;
  icon: SidebarIconName;
  count?: number;
};

export type SidebarUser = {
  name: string;
  subtitle?: string;
  href?: string;
};

export const DEFAULT_SIDEBAR_ITEMS: SidebarItem[] = [
  { id: "home", label: "홈", href: "/", icon: "home" },
  { id: "albums", label: "모든 앨범", href: "/albums", icon: "albums" },
  { id: "recent", label: "최근 리프", href: "/recent", icon: "recent" },
  { id: "favorites", label: "즐겨찾기", href: "/favorites", icon: "favorites" },
  { id: "trash", label: "휴지통", href: "/trash", icon: "trash" },
  { id: "practice", label: "연습 도구", href: "/practice", icon: "practice" },
  { id: "manual", label: "사용 안내", href: "/manual", icon: "manual" },
  { id: "settings", label: "설정", href: "/settings", icon: "settings" },
];

const sidebarIcons: Record<SidebarIconName, LucideIcon> = {
  home: House,
  albums: Folders,
  recent: Clock3,
  favorites: Star,
  trash: Trash2,
  practice: Music2,
  manual: BookOpenText,
  settings: Settings2,
};

export type DriveSidebarProps = {
  currentId?: string;
  items?: SidebarItem[];
  newHref?: string;
  user?: SidebarUser;
  compact?: boolean;
};

export function DriveSidebar({
  currentId = "home",
  items = DEFAULT_SIDEBAR_ITEMS,
  newHref = "/riffs/new",
  user = {
    name: DEFAULT_ACCOUNT_DISPLAY_NAME,
    subtitle: `@${DEFAULT_ACCOUNT_USERNAME}`,
  },
  compact = false,
}: DriveSidebarProps) {
  const userContents = (
    <>
      <span className={styles.avatar} aria-hidden="true">
        <UserRound size={16} />
      </span>
      <span className={styles.userCopy}>
        <strong>{user.name}</strong>
        {user.subtitle ? <small>{user.subtitle}</small> : null}
      </span>
    </>
  );

  return (
    <aside className={`${styles.sidebar} ${compact ? styles.sidebarCompact : ""}`}>
      <Link className={styles.brand} href="/" aria-label="Riff Sketchbook 홈">
        <span className={styles.brandMark} aria-hidden="true">
          <Guitar size={18} strokeWidth={1.8} />
        </span>
        <span>Riff Sketchbook</span>
      </Link>

      <Link className={styles.newButton} href={newHref}>
        <Plus size={18} strokeWidth={2.1} aria-hidden="true" />
        <span>새 리프</span>
      </Link>

      <nav className={styles.nav} aria-label="라이브러리">
        {items.map((item) => {
          const Icon = sidebarIcons[item.icon];
          const active = item.id === currentId;
          return (
            <Link
              className={styles.navItem}
              href={item.href}
              key={item.id}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              <span>{item.label}</span>
              {typeof item.count === "number" ? <small>{item.count}</small> : null}
            </Link>
          );
        })}
      </nav>

      <div className={styles.sidebarSpacer} />

      {user.href ? (
        <Link className={styles.userRow} href={user.href}>
          {userContents}
        </Link>
      ) : (
        <div className={styles.userRow}>
          {userContents}
          <LogoutButton
            className={styles.logoutButton}
            errorClassName={styles.logoutError}
          />
        </div>
      )}
    </aside>
  );
}

export type TopBarProps = {
  searchAction?: string;
  searchDefaultValue?: string;
  searchPlaceholder?: string;
  view?: "grid" | "list";
  gridHref?: string;
  listHref?: string;
  mobileNavigation?: ReactNode;
};

export function TopBar({
  searchAction = "/",
  searchDefaultValue,
  searchPlaceholder = "앨범, 리프, 키 검색",
  view,
  gridHref = "/?view=grid",
  listHref = "/?view=list",
  mobileNavigation,
}: TopBarProps) {
  return (
    <header className={styles.topbar}>
      {mobileNavigation ? (
        <MobileNavigationMenu>{mobileNavigation}</MobileNavigationMenu>
      ) : null}

      <TopBarSearch
        key={`${searchAction}:${searchDefaultValue ?? ""}`}
        action={searchAction}
        defaultValue={searchDefaultValue}
        placeholder={searchPlaceholder}
      />

      {view ? (
        <div className={styles.viewSwitch} role="group" aria-label="보기 방식">
          <Link href={gridHref} aria-current={view === "grid" ? "page" : undefined} aria-label="격자 보기">
            <LayoutGrid size={17} aria-hidden="true" />
          </Link>
          <Link href={listHref} aria-current={view === "list" ? "page" : undefined} aria-label="목록 보기">
            <List size={18} aria-hidden="true" />
          </Link>
        </div>
      ) : null}
    </header>
  );
}

export type AppShellProps = {
  children: ReactNode;
  currentSection?: string;
  items?: SidebarItem[];
  newHref?: string;
  searchAction?: string;
  searchDefaultValue?: string;
  user?: SidebarUser;
  view?: "grid" | "list";
  gridHref?: string;
  listHref?: string;
  searchPlaceholder?: string;
};

export function AppShell({
  children,
  currentSection = "home",
  items = DEFAULT_SIDEBAR_ITEMS,
  newHref,
  searchAction,
  searchDefaultValue,
  user,
  view,
  gridHref,
  listHref,
  searchPlaceholder,
}: AppShellProps) {
  const sidebarProps = { currentId: currentSection, items, newHref, user };

  return (
    <div className={styles.appShell}>
      <a className={styles.skipLink} href="#main-content">본문으로 건너뛰기</a>
      <div className={styles.desktopSidebar}>
        <DriveSidebar {...sidebarProps} />
      </div>
      <div className={styles.appWorkspace}>
        <TopBar
          searchAction={searchAction}
          searchDefaultValue={searchDefaultValue}
          view={view}
          gridHref={gridHref}
          listHref={listHref}
          searchPlaceholder={searchPlaceholder}
          mobileNavigation={<DriveSidebar {...sidebarProps} compact />}
        />
        <main className={styles.appContent} id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}

export function CreateAlbumLink({ href = "/albums/new" }: { href?: string }) {
  return (
    <Link className={styles.secondaryAction} href={href}>
      <FolderPlus size={17} />
      <span>새 앨범</span>
    </Link>
  );
}
