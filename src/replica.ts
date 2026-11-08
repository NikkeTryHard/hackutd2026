import type { Scenario } from './contracts';
import { amazonShopHtml } from './replica-assets/amazon/amazon';

/**
 * Controlled replica pages for the two approved scenarios.
 *
 * The HTML talks only to its own origin:
 *   GET  /api/world/:agentId              -> World JSON without the evaluator defect flag
 *   POST /api/world/:agentId/action       -> {action, value?} -> World JSON
 *   POST /api/world/:agentId/ack          -> {revision} -> {ok:true}
 *
 * The agent id comes from ?agent= (agentId/id are accepted as aliases) so the
 * page can be opened by the worker and by deterministic smoke tests.
 *
 * World action vocabulary (shared with the backend):
 *   shop   search(query|omitted), select(productId), variant(variantId),
 *          addToCart(productId), checkout("synthetic"); served by the Amazon
 *          replica asset in ./replica-assets/amazon/amazon
 *   portal search(query|omitted), panel(panelId), closePanel(panelId),
 *          schedule("YYYY-MM-DD|HH:MM|sessionType")
 *
 * World.selected encodes the shop selection as "productId" or
 * "productId/variantId"; an empty string means nothing is selected.
 *
 * This module renders the portal page. Defect conditions are authored in the
 * page that owns them and only become observable when the durable world
 * exposes the matching visible state. The server never sends a defect flag,
 * and the page never reveals that a defect world is active. A normal run seeded
 * with the authored defect reaches these branches; a clean verification rerun
 * uses the clean seed and stays fully functional.
 *   portal - when world.notice contains "maintenance" (the seeded visible
 *            maintenance announcement):
 *              * the Printing & Labs tile ignores activation and never opens;
 *              * the Library panel's close control ignores activation;
 *              * "Add to my plan" duplicates each saved local plan entry;
 *              * search result counts undercount visible matches by one.
 *   shop   - when world.stock is 0 and the notice reports out of stock or a
 *            backorder (the seeded out-of-stock announcement):
 *              * Add to Cart reports success while the server rejects the add;
 *              * Checkout is enabled with an empty cart and gets stuck
 *                "Checking out…";
 *              * search result counts overcount matches by one;
 *              * the stock status is clipped and low-contrast.
 */
export function replicaHtml(scenario: Scenario): string {
  if (scenario === 'shop') return amazonShopHtml();
  const title = 'Campus Services';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — controlled replica</title>
<style>
:root {
  --ink: #132238;
  --muted: #58687c;
  --line: #d5dde7;
  --bg: #f2f5f8;
  --card: #ffffff;
  --accent: #0b6e4f;
  --accent-dark: #08553d;
  --accent-soft: #e4f1ea;
  --warn: #8a4b00;
  --bad: #a51d2d;
  --focus: #c2410c;
  --radius: 12px;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", sans-serif;
  font-size: 15px;
  line-height: 1.45;
  color: var(--ink);
  background: var(--bg);
}
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.skip {
  position: absolute; left: -9999px; top: 0; z-index: 100;
  background: #fff; color: var(--ink); padding: 10px 14px; border-radius: 0 0 8px 0;
}
.skip:focus { left: 0; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.topbar {
  background: #102a43; color: #f0f4f8;
  padding: 10px 22px;
  display: flex; align-items: center; justify-content: space-between; gap: 18px;
  flex-wrap: wrap;
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 750; letter-spacing: .01em; }
.brand-mark {
  width: 30px; height: 30px; border-radius: 8px;
  background: #f0f4f8; color: #102a43;
  display: grid; place-items: center; font-weight: 900;
}
.tag {
  font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  background: rgba(240, 244, 248, .14); color: #d9e2ec; border: 1px solid rgba(240, 244, 248, .28);
  border-radius: 999px; padding: 3px 9px;
}
.conn { font-size: 12px; color: #bcccdc; }
.shell { max-width: 1220px; margin: 0 auto; padding: 20px 22px 46px; }
.page-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 18px;
  margin: 4px 0 16px; flex-wrap: wrap;
}
.eyebrow {
  margin: 0 0 2px; font-size: 11px; font-weight: 800; letter-spacing: .1em;
  text-transform: uppercase; color: var(--accent);
}
h1 { margin: 0; font-size: 27px; line-height: 1.15; letter-spacing: -.02em; }
.lede { margin: 6px 0 0; color: var(--muted); max-width: 640px; }
h2 { margin: 0; font-size: 18px; line-height: 1.2; }
h3 { margin: 0 0 4px; font-size: 16px; }
.section-title { margin: 0 0 10px; }
.subhead { margin: 18px 0 8px; font-size: 14px; }
.muted { color: var(--muted); }
.eyebrow + h1 { margin-top: 0; }
.date-chip {
  background: var(--card); border: 1px solid var(--line); border-radius: 999px;
  padding: 9px 16px; font-weight: 650; white-space: nowrap;
}
.banner {
  border-radius: 10px; padding: 11px 14px; margin: 0 0 14px;
  border: 1px solid var(--line); background: var(--card);
}
.banner.error { border-color: #e4a9b0; background: #fff3f4; color: var(--bad); }
.banner.notice { border-color: #cfe0d7; background: var(--accent-soft); color: #123b2c; }
.toolbar {
  display: flex; align-items: center; gap: 10px; margin: 0 0 18px; flex-wrap: wrap;
  background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px 14px;
}
.toolbar input[type="search"] { flex: 1 1 320px; }
input, select {
  min-height: 40px; padding: 8px 10px; border: 1px solid #b7c3d1; border-radius: 8px;
  background: #fff; color: var(--ink); font: inherit;
}
input[type="search"] { min-width: 0; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 650; }
.btn {
  min-height: 40px; padding: 8px 15px; border-radius: 9px;
  border: 1px solid #b7c3d1; background: #fff; color: var(--ink);
  font: inherit; font-weight: 700; cursor: pointer;
}
.btn:hover { background: #eef3f8; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:hover { background: var(--accent-dark); }
.btn.small { min-height: 34px; padding: 5px 11px; }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px;
}
.empty { color: var(--muted); font-style: italic; margin: 10px 0; }
.tile-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.tile {
  display: flex; gap: 9px; align-items: flex-start; min-height: 88px;
  padding: 10px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--card); color: inherit; text-align: left; font: inherit; cursor: pointer;
}
.tile:hover { border-color: #8fa1b6; background: #fbfcfe; }
.tile[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.tile-icon {
  flex: 0 0 30px; width: 30px; height: 30px; border-radius: 8px;
  display: grid; place-items: center; background: var(--accent-soft); color: #0a5a42;
  font-size: 11px; font-weight: 850; letter-spacing: .02em;
}
.tile-body { min-width: 0; }
.tile strong { display: block; font-size: 13px; line-height: 1.25; }
.tile small { display: block; margin-top: 2px; font-size: 11px; line-height: 1.3; color: var(--muted); }
.panel { margin-top: 16px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
.panel-head h2:focus { outline: none; }
.panel-head h2:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.panel p { margin: 6px 0; }
.schedule { margin-top: 16px; }
.schedule-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin: 10px 0; }
.session-list { margin: 8px 0 0; padding-left: 20px; }
.session-list li { margin: 5px 0; }
.confirmation { color: #0a5a42; font-weight: 650; min-height: 22px; }
.toast {
  position: fixed; right: 18px; bottom: 18px; z-index: 60;
  max-width: 380px; padding: 11px 15px; border-radius: 10px;
  background: #0f2e25; color: #fff; box-shadow: 0 10px 26px rgba(0, 0, 0, .24);
  font-weight: 650;
}
@media (max-width: 1150px) {
  .tile-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .tile-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .shell { padding: 14px 14px 34px; }
  .tile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  h1 { font-size: 23px; }
}
@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto !important; }
}
</style>
</head>
<body data-scenario="${scenario}">
<a class="skip" href="#main">Skip to main content</a>
<header class="topbar">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true">S</span>
    <span id="brandName">${title}</span>
    <span class="tag">Controlled replica</span>
  </div>
  <div class="conn" id="connectionStatus" role="status" aria-live="polite">Connecting…</div>
</header>
<main id="main" class="shell" tabindex="-1">
  <div id="fatal" class="banner error" hidden role="alert"></div>
  <div id="errorBanner" class="banner error" hidden role="alert"></div>
  <div id="noticeBanner" class="banner notice" hidden role="status"></div>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

  <section id="portalView" hidden aria-labelledby="portalHeading">
    <div class="page-head">
      <div>
        <p class="eyebrow">Synthetic campus portal</p>
        <h1 id="portalHeading">Campus Services</h1>
        <p class="lede">Generic services for controlled testing. No institutional affiliation.</p>
      </div>
      <div class="date-chip" id="todayChip"></div>
    </div>
    <div class="toolbar" role="search" aria-label="Search services">
      <label class="sr-only" for="portalSearch">Search services</label>
      <input id="portalSearch" type="search" autocomplete="off" placeholder="Search 18 campus services">
      <button id="portalSearchButton" class="btn" type="button">Search</button>
      <span id="portalResultCount" class="muted" role="status" aria-live="polite">18 services</span>
    </div>
    <section aria-labelledby="tilesHeading">
      <h2 id="tilesHeading" class="section-title">Services</h2>
      <div id="tileGrid" class="tile-grid"></div>
      <p id="portalEmpty" class="empty" hidden>No services match this search.</p>
      <p id="portalStatus" class="muted" role="status" aria-live="polite"></p>
    </section>
    <section id="panelArea" class="card panel" hidden aria-labelledby="panelHeading">
      <div class="panel-head">
        <h2 id="panelHeading" class="section-title" tabindex="-1"></h2>
        <button id="closePanelButton" class="btn small" type="button">Close panel</button>
      </div>
      <div id="panelContent"></div>
    </section>
    <section class="card schedule" aria-labelledby="scheduleHeading">
      <div class="panel-head">
        <h2 id="scheduleHeading" class="section-title">Weekly schedule</h2>
        <span class="tag" id="planCount">0 saved</span>
      </div>
      <div class="schedule-controls">
        <label>Week of <input id="weekStart" type="date"></label>
        <label>Day
          <select id="scheduleDay">
            <option>Monday</option>
            <option>Tuesday</option>
            <option>Wednesday</option>
            <option>Thursday</option>
            <option>Friday</option>
          </select>
        </label>
      </div>
      <ul id="scheduleList" class="session-list"></ul>
      <div class="schedule-controls add-row">
        <label>Session
          <select id="sessionType">
            <option>Advising</option>
            <option>Library workshop</option>
            <option>Study room</option>
            <option>Tutoring</option>
          </select>
        </label>
        <label>Time
          <select id="sessionTime">
            <option>09:00</option>
            <option>10:00</option>
            <option>11:00</option>
            <option>13:00</option>
            <option>14:00</option>
            <option>15:00</option>
          </select>
        </label>
        <button id="addSessionButton" class="btn primary" type="button">Add to my plan</button>
      </div>
      <p id="scheduleConfirm" class="confirmation" role="status" aria-live="polite"></p>
      <div>
        <h3 class="subhead">My plan</h3>
        <ul id="planList" class="session-list"><li class="muted">No sessions saved yet.</li></ul>
      </div>
    </section>
  </section>
</main>
<script>
(function () {
  'use strict';

  const SCENARIO = document.body.getAttribute('data-scenario') || '';
  const PANELS = [
    { id: 'calendar', name: 'Academic Calendar', desc: 'Semester dates, deadlines and holidays', keywords: 'dates deadline holiday semester term', lines: ['Fall term runs from August 24 to December 11 (synthetic).', 'The add/drop deadline is September 4 (synthetic).', 'Reading day is December 12; final exams begin December 14 (synthetic).'] },
    { id: 'catalog', name: 'Course Catalog', desc: 'Browse sample courses and prerequisites', keywords: 'courses classes prerequisites degree', lines: ['Sample courses include Introduction to Data Analysis, Writing Seminar and Design Studio.', 'Most sample courses list no prerequisites beyond first-year standing.', 'Seats and meeting times shown here are synthetic demo values.'] },
    { id: 'schedule', name: 'Class Schedule', desc: 'Weekly sessions and saved plans', keywords: 'classes timetable week plan sessions', lines: ['Your demo week includes lectures, a lab and one advising appointment.', 'Use the weekly schedule widget below to save a synthetic session to your plan.', 'Schedule changes are not connected to a real institution.'] },
    { id: 'grades', name: 'Grades & Transcripts', desc: 'Final grades and unofficial transcript', keywords: 'gpa transcript marks grades result', lines: ['Unofficial transcript for the demo student: 12 credits completed.', 'Term GPA shown in this replica is synthetic and not academic advice.', 'Official transcript requests are not available in this demo.'] },
    { id: 'aid', name: 'Financial Aid', desc: 'Applications, awards and documents', keywords: 'scholarship loan fafsa money award', lines: ['Demo aid application status: submitted.', 'No real financial information is requested or stored.', 'Document upload is intentionally unavailable in this replica.'] },
    { id: 'accounts', name: 'Student Accounts', desc: 'Tuition balance and payments', keywords: 'billing tuition payment balance refund', lines: ['Demo account balance: $0.00.', 'No payment methods are collected.', 'Billing questions route to a synthetic help desk contact.'] },
    { id: 'library', name: 'Library', desc: 'Hours, loans and study spaces', keywords: 'books study seats loans hours', lines: ['Demo library hours: 08:00 to 22:00 on weekdays.', 'Two study rooms are shown as available in this synthetic schedule.', 'Loans and fines are not connected to a real catalog.'] },
    { id: 'advising', name: 'Advising', desc: 'Appointments and degree planning', keywords: 'advisor degree plan appointment', lines: ['Your demo advisor holds drop-in hours on Tuesday and Thursday.', 'Degree progress: 45 percent of a synthetic plan complete.', 'Book a demo appointment from the weekly schedule widget.'] },
    { id: 'tutoring', name: 'Tutoring Center', desc: 'Subject tutoring and review sessions', keywords: 'help math writing tutor review', lines: ['Peer tutoring is available for writing, math and introductory programming.', 'Sessions are synthetic and do not reserve a real tutor.', 'Drop-in review sessions run each Wednesday afternoon.'] },
    { id: 'career', name: 'Career Services', desc: 'Resume reviews and job fairs', keywords: 'jobs resume internship career fair', lines: ['Demo resume review slots open every Friday.', 'A synthetic campus job fair is listed for October 15.', 'No employer or job data is real.'] },
    { id: 'health', name: 'Health & Counseling', desc: 'Clinic hours and wellness resources', keywords: 'medical counseling wellness clinic health', lines: ['Demo clinic hours: 09:00 to 17:00, Monday to Friday.', 'Counseling appointments in this replica are synthetic.', 'For emergencies, use the Emergency Info panel.'] },
    { id: 'housing', name: 'Housing & Dining', desc: 'Residence info and dining menus', keywords: 'dorm food meal housing residence dining', lines: ['Demo dining hall serves breakfast, lunch and dinner.', 'Residence hall front desks are staffed 24 hours in this synthetic world.', 'Housing applications are not connected to a real system.'] },
    { id: 'parking', name: 'Parking & Transit', desc: 'Permits, lots and shuttle routes', keywords: 'car bus shuttle permit parking transit', lines: ['A synthetic shuttle leaves every 15 minutes from the east lot.', 'Demo parking permits are available for lot B only.', 'Live arrival predictions are not provided.'] },
    { id: 'printing', name: 'Printing & Labs', desc: 'Printers, lab computers and supplies', keywords: 'print computer lab scanner printing', lines: ['The demo lab has 24 workstations and two black-and-white printers.', 'Print credit shown in this replica is synthetic.', 'Report a printer problem to the IT Help Desk panel.'] },
    { id: 'it', name: 'IT Help Desk', desc: 'Accounts, passwords and software', keywords: 'password email wifi software account help', lines: ['Demo support covers password resets, campus Wi-Fi and software installs.', 'No real account credentials are accepted or stored.', 'Walk-in support is listed in the synthetic service directory.'] },
    { id: 'accessibility', name: 'Accessibility Services', desc: 'Accommodations and assistive technology', keywords: 'accommodation disability assistive access', lines: ['Demo accommodations include extended time and accessible formats.', 'Assistive technology demonstrations are available by appointment.', 'Requests in this replica are synthetic and not reviewed by staff.'] },
    { id: 'events', name: 'Campus Events', desc: 'Talks, fairs and student activities', keywords: 'activities talks fair events calendar', lines: ['Demo events this week: a research talk, a club fair and a film night.', 'All event listings are synthetic.', 'Event registration is not connected to a real ticketing system.'] },
    { id: 'emergency', name: 'Emergency Info', desc: 'Contacts and safety procedures', keywords: 'safety police urgent emergency contact', lines: ['For a real emergency, call local emergency services immediately.', 'This replica provides only synthetic safety information.', 'Demo campus safety contact: extension 5555.'] }
  ];
  const SESSIONS = {
    Monday: [['09:00', 'Study hall', 'Library room 2'], ['11:00', 'Advising drop-in', 'Student services'], ['14:00', 'Writing workshop', 'Tutoring center']],
    Tuesday: [['10:00', 'Data analysis lecture', 'Hall 3'], ['13:00', 'Library tour', 'Main library'], ['15:00', 'Career panel', 'Career services']],
    Wednesday: [['09:00', 'Design studio', 'Studio B'], ['12:00', 'Study hall', 'Library room 4'], ['16:00', 'Research talk', 'Auditorium']],
    Thursday: [['08:30', 'Lab session', 'Lab 1'], ['11:00', 'Tutoring', 'Tutoring center'], ['14:00', 'Advising drop-in', 'Student services']],
    Friday: [['10:00', 'Writing seminar', 'Hall 2'], ['13:00', 'Resume review', 'Career services'], ['15:00', 'Club fair', 'Quad']]
  };
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  const portalView = document.getElementById('portalView');
  const fatalBanner = document.getElementById('fatal');
  const errorBanner = document.getElementById('errorBanner');
  const noticeBanner = document.getElementById('noticeBanner');
  const toast = document.getElementById('toast');
  const connectionStatus = document.getElementById('connectionStatus');

  const portalSearch = document.getElementById('portalSearch');
  const portalSearchButton = document.getElementById('portalSearchButton');
  const portalResultCount = document.getElementById('portalResultCount');
  const tileGrid = document.getElementById('tileGrid');
  const portalEmpty = document.getElementById('portalEmpty');
  const portalStatus = document.getElementById('portalStatus');
  const panelArea = document.getElementById('panelArea');
  const panelHeading = document.getElementById('panelHeading');
  const panelContent = document.getElementById('panelContent');
  const closePanelButton = document.getElementById('closePanelButton');
  const todayChip = document.getElementById('todayChip');
  const weekStart = document.getElementById('weekStart');
  const scheduleDay = document.getElementById('scheduleDay');
  const scheduleList = document.getElementById('scheduleList');
  const sessionType = document.getElementById('sessionType');
  const sessionTime = document.getElementById('sessionTime');
  const addSessionButton = document.getElementById('addSessionButton');
  const scheduleConfirm = document.getElementById('scheduleConfirm');
  const planList = document.getElementById('planList');
  const planCount = document.getElementById('planCount');

  let agentId = null;
  let base = '';
  let world = null;
  let ackedRevision = -1;
  let ackInFlight = -1;
  let actionBusy = false;
  let pollTimer = null;
  let pollFailures = 0;
  let portalQuery = '';
  let activePanelId = null;
  let renderedPanelId = null;
  let toastTimer = null;
  let errorTimer = null;
  let portalStatusTimer = null;
  const planEntries = [];

  const joinText = (...parts) => parts.join('');

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setConnection(text) {
    connectionStatus.textContent = text;
  }

  function showError(text) {
    errorBanner.textContent = text;
    errorBanner.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorBanner.hidden = true;
    }, 8000);
  }

  function clearError() {
    clearTimeout(errorTimer);
    errorBanner.textContent = '';
    errorBanner.hidden = true;
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  }

  function fatal(text) {
    fatalBanner.textContent = text;
    fatalBanner.hidden = false;
    setConnection('Unavailable');
    portalView.hidden = true;
  }

  function request(url, options) {
    return fetch(url, options).then((res) => res.text().then((bodyText) => {
      let data = null;
      if (bodyText) {
        try {
          data = JSON.parse(bodyText);
        } catch {
          throw new Error(joinText('Replica server returned invalid JSON (status ', res.status, ').'));
        }
      }
      if (!res.ok) {
        const detail = typeof data?.error === 'string' && data.error
          ? data.error
          : joinText('Request failed with status ', res.status, '.');
        const requestError = new Error(detail);
        requestError.status = res.status;
        throw requestError;
      }
      return data;
    }));
  }

  function postAction(action, value) {
    const payload = { action };
    if (value !== undefined && value !== null && value !== '') payload.value = value;
    return request(joinText(base, '/action'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  function postAck(revision) {
    return request(joinText(base, '/ack'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ revision })
    });
  }

  function afterPaint(fn) {
    let called = false;
    const run = () => {
      if (called) return;
      called = true;
      fn();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        requestAnimationFrame(run);
      });
      // Headless/background tabs can throttle rAF; still acknowledge promptly.
      setTimeout(run, 250);
    } else {
      setTimeout(run, 0);
    }
  }

  function maybeAck(revision, appliedRevision) {
    if (typeof revision !== 'number') return;
    if (typeof appliedRevision === 'number' && appliedRevision >= revision) {
      if (revision > ackedRevision) ackedRevision = revision;
      return;
    }
    if (revision <= ackedRevision || ackInFlight === revision) return;
    ackInFlight = revision;
    afterPaint(() => {
      postAck(revision).then(() => {
        if (revision > ackedRevision) ackedRevision = revision;
      }).catch(() => {
        // The next poll retries the acknowledgment; rendering already happened.
      }).then(() => {
        if (ackInFlight === revision) ackInFlight = -1;
      });
    });
  }

  function acceptWorld(data) {
    if (!data || typeof data !== 'object') throw new Error('Replica server returned an empty world.');
    if (data.scenario !== SCENARIO) throw new Error('Replica world scenario does not match this page.');
    if (typeof data.revision !== 'number' || !Number.isFinite(data.revision)) throw new Error('Replica world revision is missing.');
    if (typeof data.stock !== 'number' || !Number.isFinite(data.stock)) throw new Error('Replica world stock is missing.');
    if (typeof data.notice !== 'string') throw new Error('Replica world notice is missing.');
    if (typeof data.cart !== 'number' || !Number.isFinite(data.cart)) throw new Error('Replica world cart is missing.');
    if (typeof data.selected !== 'string') throw new Error('Replica world selected value is missing.');
    if (typeof data.completed !== 'boolean') throw new Error('Replica world completion flag is missing.');
    if (!Array.isArray(data.panels)) throw new Error('Replica world panels are missing.');
    data.panels = data.panels.filter((item) => typeof item === 'string');
    if (typeof data.appliedRevision !== 'number' || !Number.isFinite(data.appliedRevision)) data.appliedRevision = 0;
    return data;
  }

  function applyWorld(data) {
    let next;
    try {
      next = acceptWorld(data);
    } catch (err) {
      showError(err.message);
      return false;
    }
    if (world && next.revision < world.revision) return false;
    world = next;
    render();
    setConnection(joinText('Connected · revision ', world.revision));
    maybeAck(world.revision, world.appliedRevision);
    return true;
  }

  function renderNotice() {
    const text = typeof world?.notice === 'string' ? world.notice.trim() : '';
    noticeBanner.textContent = text ? joinText('Notice: ', text) : '';
    noticeBanner.hidden = !text;
  }

  function render() {
    if (!world) return;
    try {
      renderNotice();
      renderPortal();
    } catch (err) {
      showError(joinText('Unable to render replica state: ', err.message));
    }
  }

  const findPanel = (id) => PANELS.find((panel) => panel.id === id) ?? null;

  function renderPortal() {
    const openPanels = world.panels.slice();
    for (const tile of tileGrid.children) {
      const opened = openPanels.includes(tile.getAttribute('data-panel'));
      tile.setAttribute('aria-pressed', opened ? 'true' : 'false');
    }
    if (openPanels.length === 0) {
      activePanelId = null;
      renderedPanelId = null;
      panelArea.hidden = true;
    } else {
      if (!openPanels.includes(activePanelId)) activePanelId = openPanels.at(-1) ?? null;
      const panel = findPanel(activePanelId);
      panelArea.hidden = false;
      if (panel) {
        panelHeading.textContent = panel.name;
        if (renderedPanelId !== panel.id) {
          panelContent.textContent = '';
          for (const line of panel.lines) panelContent.appendChild(el('p', null, line));
          renderedPanelId = panel.id;
        }
      } else {
        panelHeading.textContent = 'Service panel';
        panelContent.textContent = 'This panel is not available.';
        renderedPanelId = activePanelId;
      }
    }
  }

  function initials(name) {
    return name.split(/\\s+/).filter((word) => word.length > 0).map((word) => word.charAt(0)).join('').slice(0, 2).toUpperCase();
  }

  function buildTiles() {
    tileGrid.textContent = '';
    for (const panel of PANELS) {
      const button = el('button', 'tile');
      button.type = 'button';
      button.setAttribute('data-panel', panel.id);
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', joinText('Open ', panel.name));
      const icon = el('span', 'tile-icon', initials(panel.name));
      icon.setAttribute('aria-hidden', 'true');
      const body = el('span', 'tile-body');
      body.appendChild(el('strong', null, panel.name));
      body.appendChild(el('small', null, panel.desc));
      button.appendChild(icon);
      button.appendChild(body);
      tileGrid.appendChild(button);
    }
  }

  function portalMatches(panel, query) {
    if (!query) return true;
    const haystack = joinText(
      panel.name,
      ' ',
      panel.desc,
      ' ',
      panel.keywords,
      ' ',
      panel.lines.join(' ')
    ).toLowerCase();
    return haystack.includes(query);
  }

  function applyPortalFilter() {
    const query = portalQuery.toLowerCase();
    let shown = 0;
    for (const tile of tileGrid.children) {
      const panel = findPanel(tile.getAttribute('data-panel'));
      const visible = panel ? portalMatches(panel, query) : false;
      tile.hidden = !visible;
      if (visible) shown++;
    }
    portalEmpty.hidden = shown > 0;
    // Authored defect: during the seeded maintenance state the summary
    // undercounts visible matches by one. Clean worlds keep exact counts.
    const reported = portalDefectActive() && query && shown > 0 ? shown - 1 : shown;
    portalResultCount.textContent = joinText(reported, ' of ', PANELS.length, ' services');
  }

  function doPortalSearch(recordOnServer) {
    portalQuery = portalSearch.value.trim();
    applyPortalFilter();
    if (recordOnServer) {
      postAction('search', portalQuery || undefined).then((data) => {
        applyWorld(data);
      }).catch((err) => {
        showError(joinText('Search could not be recorded: ', err.message));
      });
    }
  }

  function portalDefectActive() {
    const notice = world?.notice;
    return typeof notice === 'string' && notice.toLowerCase().includes('maintenance');
  }

  function openPanel(id) {
    if (!world) return;
    // Authored defect: during the seeded maintenance state the Printing & Labs
    // tile ignores activation and never opens its panel.
    if (id === 'printing' && portalDefectActive()) {
      portalStatus.textContent = 'Opening Printing & Labs…';
      clearTimeout(portalStatusTimer);
      portalStatusTimer = setTimeout(() => {
        if (portalDefectActive() && activePanelId !== 'printing') {
          portalStatus.textContent = 'Printing & Labs did not respond.';
        }
      }, 1600);
      return;
    }
    portalStatus.textContent = '';
    runAction('panel', id, () => {
      activePanelId = id;
      // Re-render so opening a second tile switches the visible panel
      // immediately; the world update alone may still display the previous
      // active panel.
      renderPortal();
      setTimeout(() => {
        panelHeading.focus();
      }, 0);
    });
  }

  function closePanel() {
    if (!world || !activePanelId) return;
    // Authored defect: during the seeded maintenance state the Library panel's
    // close control ignores activation and keeps the panel open. Other panels
    // still close normally, so the page stays navigable.
    if (activePanelId === 'library' && portalDefectActive()) {
      portalStatus.textContent = 'Closing Library…';
      clearTimeout(portalStatusTimer);
      portalStatusTimer = setTimeout(() => {
        if (portalDefectActive() && activePanelId === 'library') {
          portalStatus.textContent = 'Library panel did not close.';
        }
      }, 1600);
      return;
    }
    portalStatus.textContent = '';
    runAction('closePanel', activePanelId);
  }

  function isoDate(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return joinText(date.getFullYear(), '-', month, '-', day);
  }

  function addDays(dateText, days) {
    const date = new Date(joinText(dateText, 'T00:00:00'));
    if (Number.isNaN(date.getTime())) return null;
    date.setDate(date.getDate() + days);
    return isoDate(date);
  }

  function nextMonday() {
    const date = new Date();
    const day = date.getDay();
    const add = day === 1 ? 0 : (8 - day) % 7;
    date.setDate(date.getDate() + add);
    return date;
  }

  function renderSessions() {
    scheduleList.textContent = '';
    const sessions = SESSIONS[scheduleDay.value] ?? [];
    for (const [time, title, place] of sessions) {
      const item = el('li');
      item.appendChild(el('strong', null, title));
      item.appendChild(document.createTextNode(joinText(' · ', time, ' · ', place)));
      scheduleList.appendChild(item);
    }
  }

  function renderPlan() {
    planList.textContent = '';
    if (planEntries.length === 0) {
      planList.appendChild(el('li', 'muted', 'No sessions saved yet.'));
    } else {
      for (const entry of planEntries) {
        planList.appendChild(el('li', null, joinText(entry.type, ' — ', entry.day, ' ', entry.time, ' (', entry.date, ')')));
      }
    }
    planCount.textContent = joinText(planEntries.length, ' saved');
  }

  function addPlanEntry() {
    if (!world) return;
    const weekText = weekStart.value;
    const day = scheduleDay.value;
    const time = sessionTime.value;
    const type = sessionType.value;
    if (!weekText) {
      scheduleConfirm.textContent = 'Choose a week date first.';
      weekStart.focus();
      return;
    }
    const dayIndex = DAYS.indexOf(day);
    const date = dayIndex >= 0 ? addDays(weekText, dayIndex) : null;
    if (!date) {
      scheduleConfirm.textContent = 'Choose a valid week date first.';
      weekStart.focus();
      return;
    }
    const value = joinText(date, '|', time, '|', type);
    runAction('schedule', value, () => {
      // Authored defect: the seeded maintenance state duplicates every saved
      // session in the local plan even though the server records one schedule
      // action. Clean worlds save exactly one entry.
      const copies = portalDefectActive() ? 2 : 1;
      for (let index = 0; index < copies; index += 1) {
        planEntries.push({ date, day, time, type });
      }
      renderPlan();
      scheduleConfirm.textContent = joinText('Saved to your plan: ', type, ', ', day, ' at ', time, ' (', date, ').');
      showToast('Session saved');
    });
  }

  function runAction(action, value, onSuccess) {
    if (actionBusy) {
      showToast('Please wait for the previous action to finish.');
      return;
    }
    actionBusy = true;
    postAction(action, value).then((data) => {
      actionBusy = false;
      clearError();
      applyWorld(data);
      onSuccess?.(data);
    }).catch((err) => {
      actionBusy = false;
      showError(err.message);
      fetchWorld();
    });
  }

  function bindPortalEvents() {
    tileGrid.addEventListener('click', (event) => {
      const tile = event.target instanceof Element ? event.target.closest('[data-panel]') : null;
      if (!tile) return;
      openPanel(tile.getAttribute('data-panel'));
    });
    closePanelButton.addEventListener('click', closePanel);
    portalSearchButton.addEventListener('click', () => {
      doPortalSearch(true);
    });
    portalSearch.addEventListener('input', () => {
      doPortalSearch(false);
    });
    portalSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        doPortalSearch(true);
      }
    });
    scheduleDay.addEventListener('change', renderSessions);
    addSessionButton.addEventListener('click', addPlanEntry);
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(fetchWorld, document.hidden ? 2200 : 1000);
  }

  function fetchWorld() {
    request(base, { headers: { Accept: 'application/json' } }).then((data) => {
      if (pollFailures > 0) clearError();
      pollFailures = 0;
      applyWorld(data);
      schedulePoll();
    }).catch((err) => {
      pollFailures++;
      setConnection('Replica server unavailable — retrying');
      if (pollFailures === 1) showError(joinText('World state unavailable: ', err.message));
      schedulePoll();
    });
  }

  function init() {
    const params = new URLSearchParams(window.location.search);
    agentId = params.get('agent') ?? params.get('agentId') ?? params.get('id');
    if (!agentId) {
      fatal(joinText('This replica URL is missing an agent id. Open it from a Sightline run as /', SCENARIO, '?agent=<id>.'));
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) {
      fatal('The agent id in this replica URL is not valid.');
      return;
    }
    base = joinText('/api/world/', encodeURIComponent(agentId));

    portalView.hidden = false;
    buildTiles();
    applyPortalFilter();
    renderSessions();
    renderPlan();
    weekStart.value = isoDate(nextMonday());
    todayChip.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric'
    });
    bindPortalEvents();

    setConnection('Connecting…');
    fetchWorld();
  }

  window.addEventListener('error', (event) => {
    showError(joinText('Replica interface error: ', event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    showError(joinText('Replica request failed: ', reason?.message ?? 'unknown error'));
  });

  init();
})();
</script>
</body>
</html>`;
}
