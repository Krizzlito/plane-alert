// src/app/components/results-overlay/results-overlay.component.ts
import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnDestroy,
  OnChanges,
  SimpleChanges,
  AfterViewInit,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CountryService } from '../../services/country.service';
import { PlaneFilterService } from '../../services/plane-filter.service';
import { SettingsService } from '../../services/settings.service';
import { SpecialListService } from '../../services/special-list.service';
import { ButtonComponent } from '../ui/button.component';
import { TabComponent } from '../ui/tab.component';
import { PlaneListItemComponent } from '../plane-list-item/plane-list-item.component'; // Add import for list-item component
import { interval, Subscription } from 'rxjs';
import { AircraftDbService } from '../../services/aircraft-db.service';
import { ScanService } from '../../services/scan.service';
import { MilitaryPrefixService } from '../../services/military-prefix.service';
import { haversineDistance } from '../../utils/geo-utils';
import {
  trigger,
  transition,
  style,
  query,
  animate,
} from '@angular/animations';
import { IconComponent } from '../ui/icon.component';

export interface PlaneLogEntry {
  callsign: string;
  origin: string;
  firstSeen: number;
  model?: string;
  operator?: string;
  bearing?: number;
  cardinal?: string;
  arrow?: string;
  isNew?: boolean;
  lat?: number;
  lon?: number;
  filteredOut?: boolean;
  icao: string;
  isMilitary?: boolean; // Add this property to indicate if the plane is military
  isSpecial?: boolean; // Add special plane flag
  onGround?: boolean; // Indicates if plane is on the ground
  airportName?: string; // Name of airport if plane is on ground near one
  airportCode?: string; // IATA code for airport if available
  airportLat?: number;
  airportLon?: number;
  altitude?: number | null; // plane altitude in meters, nullable to match PlaneModel
}

@Component({
  selector: 'app-results-overlay',
  standalone: true,
  imports: [
    CommonModule,
    ButtonComponent,
    TabComponent,
    PlaneListItemComponent, // Re-add PlaneListItemComponent import for template usage
  ],
  templateUrl: './results-overlay.component.html',
  styleUrls: ['./results-overlay.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('listAnimation', [
      transition('* <=> *', [
        // animate new items entering
        query(
          ':enter',
          [
            style({ opacity: 0, transform: 'translateX(-10px)' }),
            animate(
              '200ms ease-out',
              style({ opacity: 1, transform: 'translateX(0)' })
            ),
          ],
          { optional: true }
        ),
        // animate items leaving
        query(
          ':leave',
          [
            animate(
              '200ms ease-in',
              style({ opacity: 0, transform: 'translateX(10px)' })
            ),
          ],
          { optional: true }
        ),
      ]),
    ]),
  ],
})
export class ResultsOverlayComponent
  implements OnInit, OnChanges, OnDestroy, AfterViewInit
{
  constructor(
    public settings: SettingsService,
    public countryService: CountryService,
    public planeFilter: PlaneFilterService,
    private specialListService: SpecialListService,
    private cdr: ChangeDetectorRef,
    private aircraftDb: AircraftDbService,
    private scanService: ScanService,
    private militaryPrefixService: MilitaryPrefixService
  ) {
    this.specialListService.specialListUpdated$.subscribe(() => {
      this.resultsUpdated = true;
    });
  }

  // track hover state separately for each list to avoid cross-list hover
  hoveredSkyPlaneIcao: string | null = null;
  hoveredAirportPlaneIcao: string | null = null;
  hoveredSeenPlaneIcao: string | null = null;
  // Controls collapse state for 'All Planes Peeped'
  get seenCollapsed(): boolean {
    return this.settings.seenCollapsed;
  }

  @Input() skyPlaneLog: PlaneLogEntry[] = [];
  // refs to scrollable lists for fade handling
  @ViewChild('skyList') skyListRef!: ElementRef<HTMLDivElement>;
  @ViewChild('airportList') airportListRef!: ElementRef<HTMLDivElement>;
  @ViewChild('seenList') seenListRef!: ElementRef<HTMLDivElement>;
  @Input() airportPlaneLog: PlaneLogEntry[] = [];
  @Input() seenPlaneLog: PlaneLogEntry[] = [];
  @Input() loadingAirports: boolean = false;
  @Input() highlightedPlaneIcao: string | null = null; // Add this input
  @Input() activePlaneIcaos: Set<string> = new Set(); // Input for active ICAOs
  // scroll state flags
  skyListScrollable = false;
  skyListAtBottom = false;
  airportListScrollable = false;
  airportListAtBottom = false;
  seenListScrollable = false;
  seenListAtBottom = false;
  @Output() filterPrefix = new EventEmitter<PlaneLogEntry>();
  @Output() exportFilterList = new EventEmitter<void>();
  @Output() clearHistoricalList = new EventEmitter<void>();
  @Output() centerPlane = new EventEmitter<any>();
  @Output() centerAirport = new EventEmitter<{ lat: number; lon: number }>();
  @Output() hoverPlane = new EventEmitter<PlaneLogEntry>();
  @Output() unhoverPlane = new EventEmitter<PlaneLogEntry>();
  // Shuffle mode: pick random plane to follow every interval
  shuffleMode = false;
  // Military priority toggle: whether to prioritize military planes in sorting
  militaryPriority = true;
  private shuffleSub: Subscription | null = null;
  // --- Add persistent shuffle follow state ---
  private shuffleFollowedIcao: string | null = null;

  // Filtered versions of the plane logs
  filteredSkyPlaneLog: PlaneLogEntry[] = [];
  filteredAirportPlaneLog: PlaneLogEntry[] = []; // Will be kept empty
  filteredSeenPlaneLog: PlaneLogEntry[] = [];

  now = Date.now();
  refreshSub!: Subscription;
  private scanSub!: Subscription;
  private baseTitle: string = 'Plane Alert';
  private emptyTitle: string = 'Nothing peepworthy. - Plane Alert';
  private lastTitleUpdateHash: string = '';
  // Track the last known plane lists for change detection
  private lastSkyPlaneHash: string = '';
  private lastAirportPlaneHash: string = '';
  private resultsUpdated: boolean = false;
  // Flag to prevent duplicate event handling
  private ignoreNextFilterChange = false;

  // Debouncing for button clicks
  private lastToggleTime = 0;
  private readonly DEBOUNCE_TIME = 500; // ms

  // commercialMute now backed by SettingsService
  get commercialMute(): boolean {
    return this.settings.commercialMute;
  }

  private NEW_PLANE_MINUTES = 1; // Plane is 'new' for 1 minute

  // Expose services needed by the child component template bindings

  // Handle center button click from template
  public onCenterPlane(plane: PlaneLogEntry, event: Event): void {
    event.stopPropagation();
    this.centerPlane.emit(plane);
  }

  // Handle filter button click from template
  public onFilter(plane: PlaneLogEntry): void {
    this.filterPrefix.emit(plane);
  }

  // Handle clear seen list click
  public onClearHistoricalList(): void {
    this.clearHistoricalList.emit();
  }

  // Handle airport center click from child
  public handleCenterAirport(coords: { lat: number; lon: number }): void {
    this.centerAirport.emit(coords);
  }

  // Provide getTimeAgo to template
  public getTimeAgo(timestamp: number): string {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    const minutes = Math.floor(diff / 60);
    if (diff < 60) return '<1m ago';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
  }

  ngOnInit(): void {
    // initial collapse state is set via property initializer
    // Load military prefixes if needed
    this.militaryPrefixService.loadPrefixes().then(() => {
      this.resultsUpdated = true;
    });
    // commercialMute is loaded by SettingsService.load()
    // Collapse state already loaded by SettingsService.load()
    // Just update the time every second
    this.refreshSub = interval(1000).subscribe(() => {
      this.now = Date.now();
      this.sortLogs();
      this.updateFilteredLogs();

      // Check if plane lists have changed during sort
      this.checkForResultsUpdates();
    });

    // Listen for scan countdown (no debug logs)
    let previousCount = 0;
    this.scanSub = this.scanService.countdown$.subscribe((count: number) => {
      if (count > previousCount && previousCount !== 0) {
        this.resultsUpdated = true;
      }
      previousCount = count;
    });

    // Listen for commercial filter changes via the settings service
    this.settings.excludeDiscountChanged.subscribe(() => {
      if (this.ignoreNextFilterChange) {
        // Skip this event as we've already handled it locally
        this.ignoreNextFilterChange = false;
        return;
      }

      this.resultsUpdated = true;
    });

    // Handle initial page load
    this.resultsUpdated = true;
  }

  ngAfterViewInit(): void {
    // collapse state already applied via property initializer
    // Existing initialization
    this.updateFilteredLogs();
    this.updatePageTitle();
    setTimeout(() => this.updateScrollFadeStates(), 0);
  }

  ngOnChanges(changes: SimpleChanges): void {
    // When input plane lists or highlighted plane change
    if (
      changes['skyPlaneLog'] ||
      changes['airportPlaneLog'] ||
      changes['highlightedPlaneIcao']
    ) {
      this.resultsUpdated = true;
      this.sortLogs();
      this.updateFilteredLogs();
    }
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
    this.scanSub?.unsubscribe();
    document.title = this.baseTitle;
  }

  // --- Keep hover handlers in parent for now ---
  onHoverPlane(
    plane: PlaneLogEntry,
    listType: 'sky' | 'airport' | 'seen'
  ): void {
    if (listType === 'sky') this.hoveredSkyPlaneIcao = plane.icao;
    else if (listType === 'airport') this.hoveredAirportPlaneIcao = plane.icao;
    else if (listType === 'seen') this.hoveredSeenPlaneIcao = plane.icao;
    this.cdr.markForCheck();
    this.hoverPlane.emit(plane); // Still emit original event if needed by map
  }

  onUnhoverPlane(
    plane: PlaneLogEntry,
    listType: 'sky' | 'airport' | 'seen'
  ): void {
    if (listType === 'sky') this.hoveredSkyPlaneIcao = null;
    else if (listType === 'airport') this.hoveredAirportPlaneIcao = null;
    else if (listType === 'seen') this.hoveredSeenPlaneIcao = null;
    this.cdr.markForCheck();
    this.unhoverPlane.emit(plane); // Still emit original event
  }

  // --- Pass events from child up ---
  // Accept any event payload from child to avoid template type mismatch
  public handleCenterPlane(plane: any): void {
    this.centerPlane.emit(plane as PlaneLogEntry);
  }

  public handleFilterPrefix(plane: any): void {
    this.filterPrefix.emit(plane as PlaneLogEntry);
  }

  public handleToggleSpecial(plane: any): void {
    const p = plane as PlaneLogEntry;
    p.isSpecial = !p.isSpecial;
    this.specialListService.toggleSpecial(p.icao);

    this.cdr.markForCheck();
  }

  /**
   * Handle toggling the commercial filter with a button
   */
  onToggleCommercialFilter(): void {
    // Simple debouncing - prevent multiple clicks within 500ms
    const now = Date.now();
    if (now - this.lastToggleTime < this.DEBOUNCE_TIME) {
      return;
    }
    this.lastToggleTime = now;

    // Get the current value before changing it
    const currentValue = this.settings.excludeDiscount;

    // Set a flag to ignore the next event from the settings service
    this.ignoreNextFilterChange = true;

    // Toggle the current value
    this.settings.setExcludeDiscount(!currentValue);

    // Update local state
    this.resultsUpdated = true;
  }

  /**
   * Handle toggling the commercial filter from checkbox (legacy method)
   */
  onExcludeCommercialChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.settings.setExcludeDiscount(checked);
    this.resultsUpdated = true;
  }

  /**
   * Toggle muting alert sound for commercial-only results
   */
  onToggleCommercialMute(): void {
    // Toggle and persist commercial mute through settings service
    this.settings.setCommercialMute(!this.settings.commercialMute);
  }

  /**
   * Returns true if only commercial planes are found (no military in sky or airport)
   */
  get onlyCommercial(): boolean {
    return (
      this.filteredSkyPlaneLog.concat(this.filteredAirportPlaneLog).length >
        0 &&
      this.filteredSkyPlaneLog
        .concat(this.filteredAirportPlaneLog)
        .every((p) => !p.isMilitary)
    );
  }

  /** Toggle collapse/expand of the seen planes list */
  toggleSeenCollapsed(): void {
    this.settings.setSeenCollapsed(!this.settings.seenCollapsed);
    // recalc fade overlay once seen list panel toggles
    setTimeout(() => this.updateScrollFadeStates(), 0);
  }

  // Updates the filtered versions of the plane logs
  public updateFilteredLogs(): void {
    // Filter sky planes and sort: military first, then by ascending distance
    const centerLat = this.settings.lat ?? 0;
    const centerLon = this.settings.lon ?? 0;
    // Choose comparator based on militaryPriority flag
    const comparator = this.militaryPriority
      ? (a: PlaneLogEntry, b: PlaneLogEntry) => {
          if (a.isMilitary && !b.isMilitary) return -1;
          if (!a.isMilitary && b.isMilitary) return 1;
          return (
            haversineDistance(centerLat, centerLon, a.lat!, a.lon!) -
            haversineDistance(centerLat, centerLon, b.lat!, b.lon!)
          );
        }
      : (a: PlaneLogEntry, b: PlaneLogEntry) =>
          haversineDistance(centerLat, centerLon, a.lat!, a.lon!) -
          haversineDistance(centerLat, centerLon, b.lat!, b.lon!);
    this.filteredSkyPlaneLog = this.skyPlaneLog
      .filter((plane) => !plane.filteredOut)
      .sort(comparator);

    // Bring manually followed plane to top
    if (this.highlightedPlaneIcao) {
      const idx = this.filteredSkyPlaneLog.findIndex(
        (p) => p.icao === this.highlightedPlaneIcao
      );
      if (idx > 0) {
        const [followed] = this.filteredSkyPlaneLog.splice(idx, 1);
        this.filteredSkyPlaneLog.unshift(followed);
      }
    }

    // Remove airport planes from overlay: set filteredAirportPlaneLog to empty
    this.filteredAirportPlaneLog = [];

    // Sort seen planes: military first, then by distance
    this.filteredSeenPlaneLog = this.seenPlaneLog
      .filter((plane) => !plane.filteredOut)
      .sort(comparator);

    // Clear isNew if plane is older than NEW_PLANE_MINUTES
    const now = Date.now();
    for (const plane of [
      ...this.filteredSkyPlaneLog,
      ...this.filteredAirportPlaneLog,
      ...this.filteredSeenPlaneLog,
    ]) {
      if (
        plane.isNew &&
        now - plane.firstSeen > this.NEW_PLANE_MINUTES * 60 * 1000
      ) {
        plane.isNew = false;
      }
    }
    // recalc fade state: hide gradient if not scrollable or already at bottom
    setTimeout(() => this.updateScrollFadeStates(), 0);
  }

  private setMilitaryFlag(planes: PlaneLogEntry[]): void {
    planes.forEach((plane) => {
      // set remains handled elsewhere
    });
  }

  private unifyNewFlags(): void {
    const skyMap = new Map(this.skyPlaneLog.map((p) => [p.icao, p.isNew]));
    // Match seen-plane with whatever sky-plane currently has
    this.seenPlaneLog.forEach((plane) => {
      const newFlag = skyMap.get(plane.icao);
      if (typeof newFlag === 'boolean') {
        plane.isNew = newFlag;
      }
    });
  }

  public sortLogs(): void {
    // No-op: preserve order provided by parent component (already sorted by distance)
  }

  /**
   * Check if the plane lists have meaningfully changed
   * and trigger title update if needed
   */
  private checkForResultsUpdates(): void {
    // If we've already flagged an update, process it
    if (this.resultsUpdated) {
      this.updatePageTitle();
      this.resultsUpdated = false;
      return;
    }

    // Get hashes for current plane lists
    const skyHash = this.getPlaneListHash(this.skyPlaneLog);
    const airportHash = this.getPlaneListHash(this.airportPlaneLog);

    // If either hash has changed, update the title
    if (
      skyHash !== this.lastSkyPlaneHash ||
      airportHash !== this.lastAirportPlaneHash
    ) {
      this.updatePageTitle();
      this.lastSkyPlaneHash = skyHash;
      this.lastAirportPlaneHash = airportHash;
    }
  }

  /**
   * Create a simple hash of a plane list to detect changes
   * Only includes critical identifying information
   */
  private getPlaneListHash(planes: PlaneLogEntry[]): string {
    return planes
      .map(
        (p) =>
          `${p.icao}:${p.model || ''}:${p.isMilitary ? 1 : 0}:${
            p.filteredOut ? 1 : 0
          }`
      )
      .join(',');
  }

  /**
   * Updates the page title with information from the top plane in the results
   * Only updates when:
   * 1. A scan completes
   * 2. Filters are applied
   * 3. Component initializes
   * 4. Commercial filter is toggled
   */
  private updatePageTitle(): void {
    this.updateFilteredLogs();
    const topPlane = this.getTopPriorityPlane();

    if (topPlane) {
      if (topPlane.isMilitary) {
        // For military planes, show [MIL] [...]
        const code =
          this.countryService.getCountryCode(topPlane.origin)?.toUpperCase() ||
          topPlane.origin;
        const callsignPrefix = topPlane.callsign
          ? topPlane.callsign.substring(0, 3).toUpperCase()
          : 'N/A';
        const display =
          topPlane.model?.trim() || '' ? topPlane.model : topPlane.callsign;
        const titleContent = `[MIL] [${code}/${callsignPrefix}] ${display}`;
        if (titleContent !== this.lastTitleUpdateHash) {
          this.lastTitleUpdateHash = titleContent;
          document.title = `${titleContent} peeped! | ${this.baseTitle}`;
        }
      } else {
        // Special planes: same as military but without [MIL]
        const code =
          this.countryService.getCountryCode(topPlane.origin)?.toUpperCase() ||
          topPlane.origin;
        const callsignPrefix = topPlane.callsign
          ? topPlane.callsign.substring(0, 3).toUpperCase()
          : 'N/A';
        const displayModel = topPlane.model?.trim() || topPlane.callsign;
        if (topPlane.isSpecial) {
          const specialTitle = `[${code}/${callsignPrefix}] ${displayModel} peeped!`;
          if (specialTitle !== this.lastTitleUpdateHash) {
            this.lastTitleUpdateHash = specialTitle;
            document.title = `${specialTitle} | ${this.baseTitle}`;
          }
        } else {
          // Non-military, non-special: stinky title variant
          let display = '';
          if (topPlane.operator) display = topPlane.operator;
          else if (topPlane.callsign && topPlane.callsign.trim().length >= 3)
            display = topPlane.callsign;
          else if (topPlane.model) display = topPlane.model;
          if (display && display !== this.lastTitleUpdateHash) {
            this.lastTitleUpdateHash = display;
            document.title = `Just stinky ${display}. | ${this.baseTitle}`;
          }
        }
      }
    } else if (this.lastTitleUpdateHash !== '') {
      this.lastTitleUpdateHash = '';
      document.title = this.emptyTitle;
    }

    this.lastSkyPlaneHash = this.getPlaneListHash(this.skyPlaneLog);
    this.lastAirportPlaneHash = this.getPlaneListHash(this.airportPlaneLog);
  }

  /**
   * Gets the highest priority plane for display in the title
   * Always prioritize any military plane, even if it has no model
   */
  private getTopPriorityPlane(): PlaneLogEntry | undefined {
    // Use the filtered lists
    const allPlanes = [
      ...this.filteredSkyPlaneLog,
      ...this.filteredAirportPlaneLog,
    ];

    if (allPlanes.length === 0) {
      return undefined;
    }

    // Always prioritize any military plane, regardless of model
    const anyMilitary = allPlanes.find((plane) => plane.isMilitary);
    if (anyMilitary) {
      return anyMilitary;
    }

    // Otherwise, prefer a plane with a model
    const anyWithModel = allPlanes.find((plane) => plane.model);
    if (anyWithModel) {
      return anyWithModel;
    }

    // Fallback: just return the first plane
    return allPlanes[0];
  }

  /** Scroll handlers to update fade state */
  onSkyScroll(event: Event): void {
    const el = event.target as HTMLElement;
    // treat near-bottom (within 2px) as bottom to hide fade reliably
    this.skyListAtBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    this.updateScrollFadeStates();
  }

  onAirportScroll(event: Event): void {
    const el = event.target as HTMLElement;
    this.airportListAtBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    this.updateScrollFadeStates();
  }

  onSeenScroll(event: Event): void {
    const el = event.target as HTMLElement;
    this.seenListAtBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    this.updateScrollFadeStates();
  }

  /** Determine if each list needs a fade overlay or not */
  private updateScrollFadeStates(): void {
    if (this.skyListRef) {
      const el = this.skyListRef.nativeElement;
      this.skyListScrollable = el.scrollHeight > el.clientHeight + 2;
      this.skyListAtBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    }
    if (this.airportListRef) {
      const el = this.airportListRef.nativeElement;
      this.airportListScrollable = el.scrollHeight > el.clientHeight + 2;
      this.airportListAtBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    }
    if (this.seenListRef) {
      const el = this.seenListRef.nativeElement;
      this.seenListScrollable = el.scrollHeight > el.clientHeight + 2;
      this.seenListAtBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    }
  }

  /** Toggle special flag on click */
  onToggleSpecial(plane: PlaneLogEntry, event: Event): void {
    event.stopPropagation();
    plane.isSpecial = !plane.isSpecial;
    this.specialListService.toggleSpecial(plane.icao);
    // Log updated list to confirm persistence
  }
  /** Assign special flags from service */
  private setSpecialFlag(planes: PlaneLogEntry[]): void {
    planes.forEach((plane) => {
      plane.isSpecial = this.specialListService.isSpecial(plane.icao);
    });
  }

  public collapsed = localStorage.getItem('resultsOverlayCollapsed') === 'true';

  public toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    localStorage.setItem('resultsOverlayCollapsed', this.collapsed.toString());
    this.cdr.detectChanges();
  }

  /** Toggle shuffle mode on/off */
  public toggleShuffle(): void {
    const now = Date.now();
    if (now - this.lastToggleTime < this.DEBOUNCE_TIME) return;
    this.lastToggleTime = now;
    this.logShuffleModeChange(!this.shuffleMode, 'toggleShuffle');
    this.shuffleMode = !this.shuffleMode;
    if (this.shuffleMode) {
      this.startShuffle();
    } else {
      this.stopShuffle();
    }
    this.cdr.detectChanges();
  }

  /** Toggle military priority sorting on/off */
  public toggleMilitaryPriority(): void {
    this.militaryPriority = !this.militaryPriority;
    this.resultsUpdated = true;
    // Only re-sort and reshuffle if there are military planes visible
    const hasMilitary = this.filteredSkyPlaneLog.some((p) => p.isMilitary);
    if (hasMilitary) {
      this.updateFilteredLogs();
      if (this.shuffleMode) {
        this.pickAndCenterRandomPlane();
      }
    }
    this.cdr.detectChanges();
  }

  /** Number of military planes currently visible in the sky list */
  get militaryCount(): number {
    return this.filteredSkyPlaneLog.filter((p) => p.isMilitary).length;
  }

  /** Log shuffle mode changes for debugging */
  private logShuffleModeChange(newValue: boolean, source: string): void {
    if (!newValue) {
      console.warn(`[ShuffleMode] shuffleMode set to FALSE by ${source}`);
      console.warn(new Error().stack);
    } else {
      console.info(`[ShuffleMode] shuffleMode set to TRUE by ${source}`);
    }
  }

  /** Begin shuffle: immediately pick a plane, then every 30s */
  private startShuffle(): void {
    const ts = new Date().toISOString();
    this.pickAndCenterRandomPlane();
    this.shuffleSub = interval(30000).subscribe(() =>
      this.pickAndCenterRandomPlane()
    );
    console.log(`[${ts}] Shuffle started -> mode=${this.shuffleMode}`);
  }

  /** Stop shuffle mode */
  private stopShuffle(): void {
    const ts = new Date().toISOString();
    this.shuffleSub?.unsubscribe();
    this.shuffleSub = null;
    this.highlightedPlaneIcao = null;
    this.shuffleFollowedIcao = null;
    console.log(`[${ts}] Shuffle stopped -> mode=${this.shuffleMode}`);
    this.cdr.detectChanges();
  }

  /** Choose a random visible plane and emit centerPlane to follow */
  private pickAndCenterRandomPlane(): void {
    let pool: PlaneLogEntry[];
    // If military priority enabled, pick military/special first; otherwise use all visible planes
    if (this.militaryPriority) {
      const priority = this.filteredSkyPlaneLog.filter(
        (p) => p.isMilitary || p.isSpecial
      );
      pool = priority.length
        ? priority
        : this.filteredSkyPlaneLog.filter(
            (p) => !p.onGround && p.altitude != null && p.altitude > 200
          );
    } else {
      // no prioritization: pick from all visible airborne planes
      pool = this.filteredSkyPlaneLog.filter(
        (p) => !p.onGround && p.altitude != null && p.altitude > 200
      );
    }

    if (pool.length === 0) {
      return;
    }

    // Always pick a new random plane
    const idx = Math.floor(Math.random() * pool.length);
    const selected = pool[idx];
    this.shuffleFollowedIcao = selected.icao;
    this.highlightedPlaneIcao = selected.icao;

    const planeToFollow = { ...selected, followMe: true };
    this.centerPlane.emit(planeToFollow);
    this.cdr.markForCheck();
  }

  /**
   * Trigger a new shuffle selection, called when a shuffled plane disappears
   * Public method to be called from the map component
   */
  public triggerNewShuffle(): void {
    if (this.shuffleMode) {
      this.pickAndCenterRandomPlane();
    }
  }
}
