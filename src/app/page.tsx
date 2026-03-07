"use client";

import Script from "next/script";
import TestDriveTab from "@/components/TestDriveTab";
import NewTripInsightsBridge from "@/components/NewTripInsightsBridge";

export default function Home() {
  return (
    <>
      <noscript>You need to enable JavaScript to run this app.</noscript>
      <div id="root" />
      <NewTripInsightsBridge />
      <TestDriveTab />

      <Script id="ecospeed-remove-badge" strategy="afterInteractive">
        {`!function(){function e(){const e=document.getElementById("emergent-badge");e&&e.remove();document.querySelectorAll('a[href*="emergent"], a[href*="emergentagent"]').forEach(e=>{e.textContent&&e.textContent.toLowerCase().includes("made with emergent")&&e.remove()})}e(),"loading"===document.readyState&&document.addEventListener("DOMContentLoaded",e),setInterval(e,1e3)}();`}
      </Script>

      <Script id="ecospeed-posthog" strategy="afterInteractive">
        {`!function(e,t){var r,s,o,i;t.__SV||(window.posthog=t,t._i=[],t.init=function(n,a,p){function c(e,t){var r=t.split(".");2==r.length&&(e=e[r[0]],t=r[1]),e[t]=function(){e.push([t].concat(Array.prototype.slice.call(arguments,0)))}}(o=e.createElement("script")).type="text/javascript",o.crossOrigin="anonymous",o.async=!0,o.src=a.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(i=e.getElementsByTagName("script")[0]).parentNode.insertBefore(o,i);var g=t;for(void 0!==p?g=t[p]=[]:p="posthog",g.people=g.people||[],g.toString=function(e){var t="posthog";return"posthog"!==p&&(t+="."+p),e||(t+=" (stub)"),t},g.people.toString=function(){return g.toString(1)+".people (stub)"},r="init me ws ys ps bs capture je Di ks register register_once register_for_session unregister unregister_for_session Ps getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey canRenderSurveyAsync identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty Es $s createPersonProfile Is opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing Ss debug xs getPageViewId captureTraceFeedback captureTraceMetric".split(" "),s=0;s<r.length;s++)c(g,r[s]);t._i.push([n,a,p])},t.__SV=1)}(document,window.posthog||[]),posthog.init("phc_yJW1VjHGGwmCbbrtczfqqNxgBDbhlhOWcdzcIJEOTFE",{api_host:"https://us.i.posthog.com",person_profiles:"identified_only"});`}
      </Script>

      <Script id="ecospeed-clear-sw-cache" strategy="afterInteractive">
        {`(async function(){try{if('serviceWorker' in navigator){const regs=await navigator.serviceWorker.getRegistrations();await Promise.all(regs.map(r=>r.unregister()));}if('caches' in window){const keys=await caches.keys();await Promise.all(keys.map(k=>caches.delete(k)));}}catch(e){console.warn('Cache cleanup skipped',e);}})();`}
      </Script>

      <Script src="/static/js/main.274975f3.js?v=7" strategy="afterInteractive" />
    </>
  );
}
