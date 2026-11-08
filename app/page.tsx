import Link from 'next/link';
import LandingNav from './landing-nav';
import ThemeToggle from './theme-toggle';
import './landing.css';

export default function Page() {
  return (
    <main className="landing">
      <LandingNav>
        <Link className="landing-brand" href="/" aria-label="Sightline home">
          <svg className="landing-mark" viewBox="0 0 32 40" aria-hidden="true" fill="currentColor">
            <path d="M3 2v29l8-7 7 14 6-3-7-14h12L3 2Z" />
          </svg>
          Sightline<span className="landing-brand-dot">.</span>
        </Link>
        <nav className="landing-links" aria-label="Main navigation">
          <a href="#demo">The demo</a>
          <a href="#how-it-works">How it works</a>
        </nav>
        <div className="landing-nav-actions">
          <ThemeToggle inline />
          <a
            className="landing-github"
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            title="GitHub"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.54v-2.1c-3.1.67-3.76-1.31-3.76-1.31-.5-1.28-1.23-1.62-1.23-1.62-1.01-.69.08-.68.08-.68 1.12.08 1.7 1.15 1.7 1.15.99 1.69 2.6 1.2 3.23.92.1-.72.39-1.2.71-1.48-2.48-.28-5.08-1.24-5.08-5.52 0-1.22.44-2.21 1.15-2.99-.12-.28-.5-1.42.11-2.95 0 0 .94-.3 3.05 1.14a10.6 10.6 0 0 1 5.56 0c2.12-1.44 3.05-1.14 3.05-1.14.61 1.53.23 2.67.11 2.95.72.78 1.15 1.77 1.15 2.99 0 4.3-2.6 5.24-5.09 5.52.4.35.76 1.02.76 2.06v3.06c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z" />
            </svg>
          </a>
          <Link className="landing-button landing-nav-cta" href="/dashboard">
            Get started <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </LandingNav>
      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="landing-orbit landing-orbit-one" aria-hidden="true" />
        <div className="landing-orbit landing-orbit-two" aria-hidden="true" />
        <a className="landing-pill" href="#demo">
          <span className="landing-new-badge">New</span>A new perspective on usability
          <span aria-hidden="true">↗</span>
        </a>
        <h1 id="hero-title">
          UI/UX for the people,
          <br />
          <span className="landing-muted">by the people</span>
          <span className="landing-period">.</span>
        </h1>
        <p className="landing-subtitle">
          Your interface. A world of perspectives.
          <br />
          Watch visual agents explore, get stuck, and show you what to improve.
        </p>
        <div className="landing-hero-actions">
          <Link className="landing-button landing-primary" href="/dashboard">
            Get started <span aria-hidden="true">↗</span>
          </Link>
          <a className="landing-secondary" href="#demo">
            <span className="landing-play" aria-hidden="true">
              ▷
            </span>
            See it in action
          </a>
        </div>
        <p className="landing-footnote">
          Different perspectives. Real browser actions. Evidence you can see.
        </p>
        <div className="landing-floating landing-floating-left" aria-hidden="true">
          <span className="landing-mini-cursor">↖</span>
          <span>Keyboard-only</span>
        </div>
        <div className="landing-floating landing-floating-right" aria-hidden="true">
          <span className="landing-status-check">✓</span>
          <span>
            Finding recorded<small>Backed by visible evidence</small>
          </span>
        </div>
      </section>
      <section id="demo" className="landing-demo" aria-label="Browser automation demonstration">
        <video
          className="landing-video"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster="/media/sightline-browser-demo-poster.jpg"
          aria-label="Accelerated 60 fps presentation replay of recorded DeepSeek actions on synthetic shopping and campus replicas"
        >
          <source src="/media/sightline-browser-demo.mp4?v=clean60" type="video/mp4" />
        </video>
      </section>
      <section id="how-it-works" className="landing-how" aria-labelledby="how-title">
        <div className="landing-section-heading">
          <span className="landing-eyebrow">LESS GUESSWORK. MORE PERSPECTIVE.</span>
          <h2 id="how-title">
            See the experience.
            <br />
            <span className="landing-muted">Not just the interface.</span>
          </h2>
          <p>
            One interface can feel completely different to someone else. Give those differences a
            place in your testing.
          </p>
        </div>
        <div className="landing-steps">
          <article>
            <span className="landing-step-number">01 / SET THE SCENE</span>
            <h3>Start with a journey.</h3>
            <p>Choose a controlled scenario and tell the agents what someone is trying to do.</p>
          </article>
          <article>
            <span className="landing-step-number">02 / CHANGE THE PERSPECTIVE</span>
            <h3>Let them find their way.</h3>
            <p>
              Explore with keyboard-only navigation, color-vision emulation, and different
              interaction profiles.
            </p>
          </article>
          <article>
            <span className="landing-step-number">03 / SEE WHAT HAPPENED</span>
            <h3>Make the next change count.</h3>
            <p>
              Review screenshots, browser actions, and recorded findings. See the evidence behind
              every observation.
            </p>
          </article>
        </div>
      </section>
      <section className="landing-bottom">
        <span className="landing-eyebrow">BUILT FOR A DIFFERENT POINT OF VIEW</span>
        <h2>
          Better experiences
          <br />
          start with seeing.
        </h2>
        <Link className="landing-button landing-primary" href="/dashboard">
          Get started <span aria-hidden="true">↗</span>
        </Link>
        <p>Explore the visual-agent testing lab.</p>
      </section>
      <footer className="landing-footer">
        <Link className="landing-brand" href="/">
          Sightline.
        </Link>
        <span>For the people, by the people.</span>
        <a href="#demo">Back to the demo ↑</a>
      </footer>
    </main>
  );
}
