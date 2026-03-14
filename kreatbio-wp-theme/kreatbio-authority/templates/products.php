<?php
/*
Template Name: Products
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
            <p class="section-kicker">Product Portfolio</p>
            <h1>Focused tools for biotech execution and capability building</h1>
            <p class="lead">
              KreatBio keeps its portfolio intentionally tight: one DNA extraction solution and one bioinformatics teaching platform.
            </p>
          </div>

          <div class="grid grid-2">
            <article class="card kit-card reveal">
              <h2>KreatPure DNA Extraction Kit</h2>
              <p>Reliable extraction workflow designed for repeat use in startup and academic lab settings.</p>
              <div class="badge-list" style="margin: 0.8rem 0">
                <span class="badge">DNA Isolation Workflow</span>
                <span class="badge">Protocol-Led Setup</span>
                <span class="badge">Lab Support</span>
              </div>
              <a class="btn btn-secondary" href="<?php echo esc_url(kreatbio_authority_page_url('kreatpure-dna-kit')); ?>">Open Product Page</a>
            </article>

            <article class="card platform-card reveal">
              <h2>KodaGeno Bioinformatics Learning Platform</h2>
              <p>Hands-on learning platform for teaching bioinformatics in classrooms and training programs.</p>
              <div class="badge-list" style="margin: 0.8rem 0">
                <span class="badge">Guided Lessons</span>
                <span class="badge">Ready Datasets</span>
                <span class="badge">Instructor Tracking</span>
              </div>
              <a class="btn btn-secondary" href="<?php echo esc_url(kreatbio_authority_page_url('kodageno-learning-platform')); ?>">Open Product Page</a>
            </article>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container reveal">
          <div class="section-title-wrap">
            <p class="section-kicker">Quick Comparison</p>
            <h2>Choose by outcome</h2>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Primary use</th>
                  <th>Best for</th>
                  <th>Main output</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>KreatPure DNA Extraction Kit</td>
                  <td>Sample processing and DNA extraction</td>
                  <td>Research labs, startup R&amp;D, teaching labs</td>
                  <td>Purified DNA for downstream work</td>
                </tr>
                <tr>
                  <td>KodaGeno Bioinformatics Learning Platform</td>
                  <td>Bioinformatics skills training</td>
                  <td>Instructors, training managers, students</td>
                  <td>Practical analysis skills and learning progress</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="callout reveal">
            <strong>Authority rule:</strong> keep public claims tied to documents, protocol steps, and support workflow you can show today.
          </div>

          <div class="cta-band reveal">
            <div>
              <h3>Need help picking a starting point?</h3>
              <p>Tell us your lab or training objective and we will map the right setup.</p>
            </div>
            <div class="hero-actions" style="margin-top: 0">
              <a class="btn btn-primary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Talk to Sales</a>
              <a class="btn btn-ghost" href="<?php echo esc_url(kreatbio_authority_page_url('resources')); ?>">See Documents</a>
            </div>
          </div>
        </div>
      </section>
    </main>
<?php get_footer(); ?>
