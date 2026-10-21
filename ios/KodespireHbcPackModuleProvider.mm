#import "KodespireHbcPackModuleProvider.h"

#import "KodespireHbcPackModule.h"

@implementation KodespireHbcPackModuleProvider

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::KodespireHbcPackModule>(params.jsInvoker);
}

@end
