<?php
/*
Template Name: KodaGeno Learning Platform
Template Post Type: page
*/
if (!defined('ABSPATH')) {
    exit;
}
get_header();
?>
<main>
      <section class="hero">
        <div class="container hero-grid">
          <div class="reveal">
            <span class="eyebrow">Training Platform</span>
            <h1>KodaGeno Bioinformatics Learning Platform</h1>
            <p class="lead">
              KodaGeno turns bioinformatics theory into guided, hands-on practice for students and early-career biotech teams.
            </p>
            <div class="hero-actions">
              <a class="btn btn-primary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Book Demo</a>
              <a class="btn btn-secondary" href="https://kodageno.com/" target="_blank" rel="noreferrer">Visit kodageno.com</a>
            </div>
          </div>
          <aside class="hero-panel reveal">
            <h3>Why instructors choose KodaGeno</h3>
            <ul class="hero-panel-list">
              <li><span class="hero-panel-dot"></span><span>Ready-to-use lesson modules and guided exercises.</span></li>
              <li><span class="hero-panel-dot"></span><span>Practice datasets for hands-on student activity.</span></li>
              <li><span class="hero-panel-dot"></span><span>Instructor tools for tracking learner completion.</span></li>
              <li><span class="hero-panel-dot"></span><span>Simple onboarding for classroom and training cohorts.</span></li>
            </ul>
          </aside>
        </div>
      </section>

      <section class="section">
        <div class="container grid grid-2">
          <article class="card reveal">
            <h2>Best fit for</h2>
            <ul class="ticks">
              <li><span class="tick-icon">+</span><span>University bioinformatics courses.</span></li>
              <li><span class="tick-icon">+</span><span>Biotech onboarding and upskilling programs.</span></li>
              <li><span class="tick-icon">+</span><span>Training tracks for new lab staff.</span></li>
            </ul>
          </article>
          <article class="card reveal">
            <h2>Learning outcomes</h2>
            <ul class="ticks">
              <li><span class="tick-icon">+</span><span>Understand core bioinformatics workflow steps.</span></li>
              <li><span class="tick-icon">+</span><span>Run guided analyses with confidence.</span></li>
              <li><span class="tick-icon">+</span><span>Interpret outputs and communicate findings clearly.</span></li>
            </ul>
          </article>
        </div>
      </section>

      <section class="section">
        <div class="container reveal">
          <div class="section-title-wrap">
            <p class="section-kicker">Teaching Resources</p>
            <h2>Instructor enablement stack</h2>
          </div>
          <div class="grid grid-3">
            <article class="card">
              <h3>Lesson plans</h3>
              <p>Structured lesson flow to reduce prep time and improve consistency.</p>
            </article>
            <article class="card">
              <h3>Instructor notes</h3>
              <p>Guidance for facilitation, expected outputs, and common learner blockers.</p>
            </article>
            <article class="card">
              <h3>Assessment templates</h3>
              <p>Simple grading and competency checks aligned with learning outcomes.</p>
            </article>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="callout reveal">
            <strong>Messaging rule:</strong> present KodaGeno as a practical learning platform. Avoid inflated "AI-powered" claims unless you can document each feature clearly.
          </div>
          <div class="cta-band reveal">
            <div>
              <h3>Launch your next cohort with less prep overhead</h3>
              <p>We can help map KodaGeno into your existing class or internal training track.</p>
            </div>
            <a class="btn btn-primary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Start Pilot Program</a>
          </div>
        </div>
      </section>
    </main>
<?php get_footer(); ?>
