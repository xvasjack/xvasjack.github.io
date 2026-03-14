<?php
/*
Template Name: Resources
Template Post Type: page
*/
if (!defined('ABSPATH')) {
    exit;
}
get_header();
?>
<main>
      <section class="hero">
        <div class="container">
          <div class="section-title-wrap reveal">
            <p class="section-kicker">Resource Center</p>
            <h1>Documentation and guidance that support confident use</h1>
            <p class="lead">This page is structured to project authority with clear, evidence-backed materials.</p>
          </div>
          <div class="badge-list reveal">
            <span class="badge">Protocols</span>
            <span class="badge">Technical Sheets</span>
            <span class="badge">Instructor Guides</span>
            <span class="badge">Troubleshooting</span>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container grid grid-2">
          <article class="card reveal">
            <h2>KreatPure document set</h2>
            <ul class="ticks">
              <li><span class="tick-icon">+</span><span>Protocol PDF and quick start card.</span></li>
              <li><span class="tick-icon">+</span><span>Technical data sheet and storage guidance.</span></li>
              <li><span class="tick-icon">+</span><span>SDS and handling notes.</span></li>
              <li><span class="tick-icon">+</span><span>Issue-resolution flow for extraction problems.</span></li>
            </ul>
          </article>

          <article class="card reveal">
            <h2>KodaGeno teaching set</h2>
            <ul class="ticks">
              <li><span class="tick-icon">+</span><span>Lesson plans with time estimates.</span></li>
              <li><span class="tick-icon">+</span><span>Instructor facilitation notes.</span></li>
              <li><span class="tick-icon">+</span><span>Assessment templates and rubric examples.</span></li>
              <li><span class="tick-icon">+</span><span>Student onboarding checklist.</span></li>
            </ul>
          </article>
        </div>
      </section>

      <section class="section">
        <div class="container reveal">
          <div class="section-title-wrap">
            <p class="section-kicker">Support Model</p>
            <h2>How support requests are handled</h2>
          </div>

          <ol class="steps">
            <li>
              <div>
                <h3>Submit context</h3>
                <p>Share sample type, use case, and issue details through the contact form.</p>
              </div>
            </li>
            <li>
              <div>
                <h3>Technical triage</h3>
                <p>Team reviews issue and maps the right protocol or lesson support response.</p>
              </div>
            </li>
            <li>
              <div>
                <h3>Resolution follow-up</h3>
                <p>Action summary is returned with next steps and any document updates needed.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="notice reveal">Do not list certifications or performance benchmarks unless they are currently validated and available for review.</div>
          <div class="cta-band reveal">
            <div>
              <h3>Need a specific document?</h3>
              <p>Ask and we will send the right protocol or teaching file set.</p>
            </div>
            <a class="btn btn-primary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Request Documents</a>
          </div>
        </div>
      </section>
    </main>
<?php get_footer(); ?>
