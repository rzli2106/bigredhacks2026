Pod::Spec.new do |s|
  s.name = 'ClearPathHealth'
  s.version = '0.1.0'
  s.summary = 'Local mobility samples for ClearPath'
  s.license = 'MIT'
  s.homepage = 'https://capacitorjs.com'
  s.author = 'ClearPath'
  s.source = { :path => '.' }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
  s.frameworks = 'HealthKit', 'CoreMotion'
end
